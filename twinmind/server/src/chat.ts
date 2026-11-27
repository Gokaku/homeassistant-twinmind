import { randomBytes, randomUUID } from "node:crypto";
import { buildPrompt } from "./handoff.js";
import type { GateDecision, McpEndpoint, ToolGate } from "./hass/mcp.js";
import { haPolicy } from "./hass/policy.js";
import { classifyRaw } from "./hass/raw.js";
import type { HaTool } from "./hass/tools.js";
import type {
  ApprovalDecision,
  ChatMessage,
  ClientMessage,
  Conversation,
  Part,
  ProviderId,
  ServerEvent,
  ToolPart,
} from "./protocol.js";
import type { Provider, ProviderEvent, SteerInput, TurnContext } from "./providers/types.js";
import { isValidId, toMeta, type ConversationStore } from "./store.js";
import type { StoredUpload, UploadStore } from "./uploads.js";

type SendMessage = Extract<ClientMessage, { type: "send" }>;

interface RunningTurn {
  controller: AbortController;
  provider: ProviderId;
  mode: string;
  /** The assistant message new output goes to. */
  assistant: ChatMessage;
  /** All assistant messages of this turn: a message steered into the turn starts a new one. */
  segments: ChatMessage[];
  requestApproval?: TurnContext["requestApproval"];
  /** Set by providers that can take more input while the turn runs. */
  steer?: (input: SteerInput) => Promise<boolean>;
}

/** A validated message, ready to run as (part of) a turn. */
interface Outgoing {
  provider: Provider;
  mode: string;
  model?: string;
  effort?: string;
  text: string;
  attachments: StoredUpload[];
  userMsg: ChatMessage;
}

interface PendingApproval {
  conversationId: string;
  messageId: string;
  partId: string;
  resolve: (d: ApprovalDecision) => void;
}

export class ChatService implements ToolGate {
  private running = new Map<string, RunningTurn>();
  private approvals = new Map<string, PendingApproval>();
  /** Open questions, by question part id. */
  private inputs = new Map<string, { conversationId: string; resolve: (a: Record<string, string[]> | null) => void }>();
  /** conversation id -> MCP token, and back. Tokens live as long as the process. */
  private tokens = new Map<string, string>();
  private tokenOwners = new Map<string, string>();
  /** conversation id -> HA tools the user allowed for the rest of the session. */
  private sessionAllowed = new Map<string, Set<string>>();
  private mcp: McpEndpoint | null = null;
  /** conversation id -> messages sent while a reply was running, to run when it ends. */
  private queues = new Map<string, Outgoing[]>();

  constructor(
    private readonly store: ConversationStore,
    private readonly uploads: UploadStore,
    private readonly providers: Map<ProviderId, Provider>,
    private readonly cwd: string,
    private readonly broadcast: (e: ServerEvent) => void,
  ) {}

  attachMcp(endpoint: McpEndpoint) {
    this.mcp = endpoint;
  }

  private mcpToken(conversationId: string): string {
    let t = this.tokens.get(conversationId);
    if (!t) {
      t = randomBytes(24).toString("base64url");
      this.tokens.set(conversationId, t);
      this.tokenOwners.set(t, conversationId);
    }
    return t;
  }

  /** ToolGate: MCP calls are only accepted while that conversation has a turn running. */
  session(token: string) {
    const cid = this.tokenOwners.get(token);
    const turn = cid ? this.running.get(cid) : undefined;
    if (!cid || !turn) return null;
    return {
      decide: (tool: HaTool, args: unknown, summary: string, signal?: AbortSignal) =>
        this.decideHaTool(cid, turn, tool, args, summary, signal),
    };
  }

  private async decideHaTool(
    cid: string,
    turn: RunningTurn,
    tool: HaTool,
    args: unknown,
    summary: string,
    signal?: AbortSignal,
  ): Promise<GateDecision> {
    if (turn.controller.signal.aborted) return { ok: false, reason: "The user stopped this reply." };
    // The session was looked up when the request arrived. Decide only for the turn that is
    // still running: a request that outlived its turn must not run with that turn's mode
    // (or put an approval card on a reply that has already ended).
    if (this.running.get(cid) !== turn) return { ok: false, reason: "This reply has already ended." };
    // Raw WebSocket/REST calls are judged by what they do; "Always" remembers that one command.
    const raw = classifyRaw(tool.name, args);
    const sensitive = raw?.kind === "sensitive";
    const key = raw?.key ?? tool.name;
    const policy = haPolicy(turn.provider, turn.mode, sensitive);
    if (policy === "allow") return { ok: true };
    if (policy === "read-only")
      return { ok: false, reason: `This chat is in a read-only mode (${turn.mode}). Describe the change instead; the user can switch modes to apply it.` };
    if (policy === "deny") return { ok: false, reason: `Changes are not allowed in this mode (${turn.mode}).` };
    if (!sensitive && this.sessionAllowed.get(cid)?.has(key)) return { ok: true };
    if (!turn.requestApproval) return { ok: false, reason: "No one is there to approve this right now." };
    // Put the approval on the assistant's own card for this tool call, if we can find it.
    const part = turn.segments
      .flatMap((m) => m.parts)
      .reverse()
      .find(
        (p): p is ToolPart =>
          p.type === "tool" &&
          (p.state === "running" || p.state === "awaiting-approval") &&
          !p.approval &&
          (p.name === tool.name || p.name.endsWith(`__${tool.name}`) || p.name.endsWith(`.${tool.name}`)),
      );
    const decision = await turn.requestApproval({
      toolPartId: part?.id ?? randomUUID(),
      name: part?.name ?? tool.name,
      kind: "ha",
      title: summary,
      input: args,
      reason: sensitive ? `${tool.title} (sensitive: always asks)` : tool.title,
      signal,
    });
    if (signal?.aborted) return { ok: false, reason: "The tool call was cancelled before it was approved." };
    if (decision === "deny") return { ok: false, reason: "The user declined this change." };
    if (decision === "allow-session" && !sensitive) {
      if (!this.sessionAllowed.has(cid)) this.sessionAllowed.set(cid, new Set());
      this.sessionAllowed.get(cid)!.add(key);
    }
    return { ok: true };
  }

  /** Drop per-conversation state when a conversation is deleted. */
  forget(conversationId: string) {
    const t = this.tokens.get(conversationId);
    if (t) this.tokenOwners.delete(t);
    this.tokens.delete(conversationId);
    this.sessionAllowed.delete(conversationId);
  }

  isRunning(conversationId: string): boolean {
    return this.running.has(conversationId);
  }

  metaWithStatus(c: Conversation) {
    return { ...toMeta(c), running: this.isRunning(c.id) };
  }

  /**
   * Validate and start a turn. Resolves once the turn has started (not when it ends). While a
   * reply is running, the message is steered into it if the provider can take it, or else
   * queued and sent when the reply ends.
   */
  async send(msg: SendMessage): Promise<void> {
    const provider = this.providers.get(msg.provider);
    if (!provider) throw new Error(`Unknown provider: ${msg.provider}`);
    if (!provider.modes.some((m) => m.id === msg.mode)) throw new Error(`Unknown mode for ${provider.label}: ${msg.mode}`);
    const text = typeof msg.text === "string" ? msg.text.slice(0, 100_000) : "";
    const attachmentIds = Array.isArray(msg.attachments) ? msg.attachments.slice(0, 10) : [];
    if (!text.trim() && attachmentIds.length === 0) throw new Error("Message is empty");
    const model = typeof msg.model === "string" && msg.model.length < 100 ? msg.model : undefined;
    const effort = typeof msg.effort === "string" && /^[a-z0-9_-]{1,32}$/i.test(msg.effort) ? msg.effort : undefined;

    const attachments: StoredUpload[] = [];
    for (const id of attachmentIds) {
      const u = await this.uploads.get(id);
      if (!u) throw new Error("Attachment not found");
      attachments.push(u);
    }

    let conv: Conversation;
    if (msg.conversationId) {
      if (!isValidId(msg.conversationId)) throw new Error("Invalid conversation id");
      const found = this.store.get(msg.conversationId);
      if (!found) throw new Error("Conversation not found");
      conv = found;
    } else {
      conv = this.store.create(msg.provider, titleFrom(text, attachments));
    }

    const userMsg: ChatMessage = {
      id: randomUUID(),
      role: "user",
      provider: msg.provider,
      model,
      effort,
      mode: msg.mode,
      createdAt: Date.now(),
      parts: [
        ...attachments.map<Part>((a) => ({
          type: "file",
          id: randomUUID(),
          uploadId: a.id,
          name: a.name,
          mediaType: a.mediaType,
          size: a.size,
        })),
        ...(text.trim() ? [{ type: "text", id: randomUUID(), text } as Part] : []),
      ],
    };
    const out: Outgoing = { provider, mode: msg.mode, model, effort, text, attachments, userMsg };
    if (conv.title === "New chat" && text.trim()) conv.title = titleFrom(text, attachments);

    const running = this.running.get(conv.id);
    if (running) return this.followUp(conv, running, out, msg.clientRequestId);
    this.store.addMessage(conv, userMsg);
    await this.startTurn(conv, [out], msg.clientRequestId);
  }

  /** A message sent while a reply is running: steer it into the reply, or queue it. */
  private async followUp(conv: Conversation, running: RunningTurn, out: Outgoing, clientRequestId: string): Promise<void> {
    const queue = this.queues.get(conv.id) ?? [];
    // Steer only into a reply of the same assistant and mode, and never past queued messages.
    const canSteer = !!running.steer && !queue.length && running.provider === out.provider.id && running.mode === out.mode;
    out.userMsg.queued = true;
    this.store.addMessage(conv, out.userMsg);
    this.broadcast({ type: "conversation", meta: this.metaWithStatus(conv), clientRequestId });
    this.broadcast({ type: "message", conversationId: conv.id, message: out.userMsg });
    if (canSteer && (await running.steer!({ text: out.text || "(see attached files)", attachments: out.attachments }).catch(() => false))) {
      // Accepted: the provider handles it within this reply.
      delete out.userMsg.queued;
      this.broadcast({ type: "message", conversationId: conv.id, message: out.userMsg });
      if (this.running.get(conv.id) === running) {
        // What the assistant says from here on answers this message: show it below it.
        const segment = this.newAssistant(out);
        this.store.addMessage(conv, segment);
        running.assistant = segment;
        running.segments.push(segment);
        this.broadcast({ type: "message", conversationId: conv.id, message: segment });
      } else if (conv.native[running.provider] && !conv.messages.some((m) => m.queued)) {
        // The reply ended while the message was being taken: it was part of that reply all the same.
        conv.seen[running.provider] = conv.messages.length;
      }
      await this.store.save(conv).catch(() => {});
      return;
    }
    if (!this.running.has(conv.id)) {
      // The reply ended in the meantime and nothing picked this message up: send it now.
      delete out.userMsg.queued;
      return this.startTurn(conv, [out]);
    }
    queue.push(out);
    this.queues.set(conv.id, queue);
    await this.store.save(conv).catch(() => {});
  }

  /** Remove a queued message before it is sent. */
  unqueue(conversationId: string, messageId: string): boolean {
    const queue = this.queues.get(conversationId);
    const i = queue?.findIndex((q) => q.userMsg.id === messageId) ?? -1;
    if (!queue || i < 0) return false;
    queue.splice(i, 1);
    this.removeMessage(conversationId, messageId);
    return true;
  }

  private removeMessage(conversationId: string, messageId: string) {
    const conv = this.store.get(conversationId);
    if (!conv) return;
    conv.messages = conv.messages.filter((m) => m.id !== messageId);
    this.broadcast({ type: "message.removed", conversationId, messageId });
    void this.store.save(conv).catch(() => {});
  }

  private newAssistant(out: Outgoing): ChatMessage {
    return {
      id: randomUUID(),
      role: "assistant",
      provider: out.provider.id,
      model: out.model,
      effort: out.effort,
      mode: out.mode,
      createdAt: Date.now(),
      parts: [],
      status: "streaming",
    };
  }

  /**
   * Run one turn for `batch`: one message, or all messages queued during the previous reply
   * (sent together, as Claude Code and Codex do; the last one's assistant, mode and model).
   * The user messages are already in the conversation.
   */
  private async startTurn(conv: Conversation, batch: Outgoing[], clientRequestId?: string): Promise<void> {
    const last = batch[batch.length - 1];
    const { provider, mode, model, effort } = last;
    const first = conv.messages.indexOf(batch[0].userMsg);
    const history = conv.messages.slice(0, first < 0 ? conv.messages.length : first);
    const assistant = this.newAssistant(last);
    this.store.addMessage(conv, assistant);
    conv.provider = provider.id;

    const controller = new AbortController();
    this.running.set(conv.id, { controller, provider: provider.id, mode, assistant, segments: [assistant] });
    this.broadcast({ type: "conversation", meta: this.metaWithStatus(conv), clientRequestId });
    for (const o of batch) this.broadcast({ type: "message", conversationId: conv.id, message: o.userMsg });
    this.broadcast({ type: "message", conversationId: conv.id, message: assistant });
    // A failed save (disk full, ...) must not leave the chat marked as running forever:
    // the turn still runs, and the end of the turn saves again.
    await this.store.save(conv).catch((e) => console.warn(`[twinmind] could not save conversation ${conv.id}: ${e?.message ?? e}`));

    const text = batch.map((o) => o.text || "(see attached files)").join("\n\n");
    const prompt = buildPrompt(conv, history, provider.id, text);
    void this.runTurn(conv, provider, prompt, batch.flatMap((o) => o.attachments), mode, model, effort, controller);
  }

  private async runTurn(
    conv: Conversation,
    provider: Provider,
    prompt: string,
    attachments: StoredUpload[],
    mode: string,
    model: string | undefined,
    effort: string | undefined,
    controller: AbortController,
  ): Promise<void> {
    const cid = conv.id;
    const pid = provider.id;
    let nativeIdSet = false;
    const turnState = this.running.get(cid)!;
    /** The assistant message that holds a part (a tool may finish after a steered message). */
    const ownerOf = (partId: string) => turnState.segments.find((m) => m.parts.some((p) => p.id === partId)) ?? turnState.assistant;
    const findPart = (partId: string) => turnState.segments.flatMap((m) => m.parts).find((p) => p.id === partId);

    const upsert = (incoming: Part) => {
      const owner = ownerOf(incoming.id);
      const i = owner.parts.findIndex((p) => p.id === incoming.id);
      let part = incoming;
      const prev = i >= 0 ? owner.parts[i] : undefined;
      // Providers re-send tool parts as they progress; keep the approval we attached.
      if (prev?.type === "tool" && part.type === "tool" && prev.approval && !part.approval) {
        part = { ...part, approval: prev.approval };
        if (prev.state === "awaiting-approval" && !prev.approval.decision && part.state === "running") {
          part.state = "awaiting-approval";
        }
      }
      if (i >= 0) owner.parts[i] = part;
      else owner.parts.push(part);
      this.broadcast({ type: "part", conversationId: cid, messageId: owner.id, part });
    };

    const emit = (e: ProviderEvent) => {
      if (controller.signal.aborted && e.type !== "native-id") return;
      switch (e.type) {
        case "native-id":
          conv.native[pid] = e.id;
          nativeIdSet = true;
          break;
        case "text-delta":
        case "reasoning-delta": {
          const kind = e.type === "text-delta" ? "text" : "reasoning";
          const owner = ownerOf(e.partId);
          let p = owner.parts.find((x) => x.id === e.partId);
          if (!p) {
            p = kind === "text" ? { type: "text", id: e.partId, text: "" } : { type: "reasoning", id: e.partId, text: "" };
            owner.parts.push(p);
            this.broadcast({ type: "part", conversationId: cid, messageId: owner.id, part: { ...p } });
          }
          if (p.type === "text" || p.type === "reasoning") p.text += e.delta;
          this.broadcast({
            type: kind === "text" ? "text.delta" : "reasoning.delta",
            conversationId: cid,
            messageId: owner.id,
            partId: e.partId,
            delta: e.delta,
          });
          break;
        }
        case "part":
          upsert(e.part);
          break;
        case "usage":
          turnState.assistant.usage = e.usage;
          this.broadcast({ type: "usage", conversationId: cid, messageId: turnState.assistant.id, usage: e.usage });
          break;
      }
    };

    const requestApproval: import("./providers/types.js").TurnContext["requestApproval"] = (req) =>
      new Promise<ApprovalDecision>((resolve) => {
        if (controller.signal.aborted || req.signal?.aborted) return resolve("deny");
        const approvalId = randomUUID();
        const existing = findPart(req.toolPartId) as ToolPart | undefined;
        const part: ToolPart = {
          ...(existing ?? {}),
          type: "tool",
          id: req.toolPartId,
          name: req.name,
          kind: req.kind,
          title: req.title,
          input: req.input ?? existing?.input,
          state: "awaiting-approval",
          approval: { id: approvalId, reason: req.reason },
        };
        upsert(part);
        void this.store.save(conv);
        const done = (d: ApprovalDecision) => {
          if (!this.approvals.delete(approvalId)) return;
          controller.signal.removeEventListener("abort", onAbort);
          req.signal?.removeEventListener("abort", onAbort);
          const current = findPart(req.toolPartId) as ToolPart | undefined;
          if (current) {
            upsert({
              ...current,
              state: d === "deny" ? "denied" : "running",
              approval: { id: approvalId, decision: d, reason: req.reason },
            });
          }
          resolve(d);
        };
        const onAbort = () => done("deny");
        controller.signal.addEventListener("abort", onAbort, { once: true });
        req.signal?.addEventListener("abort", onAbort, { once: true });
        this.approvals.set(approvalId, { conversationId: cid, messageId: ownerOf(req.toolPartId).id, partId: req.toolPartId, resolve: done });
      });

    const requestInput: TurnContext["requestInput"] = (req) =>
      new Promise((resolve) => {
        if (controller.signal.aborted || req.signal?.aborted) return resolve(null);
        upsert({ type: "question", id: req.partId, questions: req.questions, state: "pending" });
        void this.store.save(conv);
        const done = (answers: Record<string, string[]> | null) => {
          if (!this.inputs.delete(req.partId)) return;
          controller.signal.removeEventListener("abort", onAbort);
          req.signal?.removeEventListener("abort", onAbort);
          upsert({
            type: "question",
            id: req.partId,
            questions: req.questions,
            state: answers ? "answered" : "dismissed",
            answers: answers ?? undefined,
          });
          resolve(answers);
        };
        const onAbort = () => done(null);
        controller.signal.addEventListener("abort", onAbort, { once: true });
        req.signal?.addEventListener("abort", onAbort, { once: true });
        this.inputs.set(req.partId, { conversationId: cid, resolve: done });
      });

    turnState.requestApproval = requestApproval;

    let status: "completed" | "interrupted" | "failed" = "completed";
    let error: string | undefined;
    try {
      const r = await provider.run({
        prompt,
        attachments,
        mode,
        model,
        effort,
        cwd: this.cwd,
        nativeId: conv.native[pid],
        mcp: this.mcp ? { url: this.mcp.url(this.mcpToken(cid)), secret: this.mcp.secret } : undefined,
        signal: controller.signal,
        emit,
        requestApproval,
        requestInput,
        setSteer: (fn) => {
          turnState.steer = fn;
        },
      });
      status = controller.signal.aborted ? "interrupted" : r.status;
    } catch (e) {
      if (controller.signal.aborted) status = "interrupted";
      else {
        status = "failed";
        error = e instanceof Error ? e.message : String(e);
        upsert({ type: "notice", id: randomUUID(), level: "error", text: error });
      }
    } finally {
      for (const [id, a] of this.approvals) if (a.conversationId === cid) a.resolve("deny"), this.approvals.delete(id);
      for (const q of [...this.inputs.values()]) if (q.conversationId === cid) q.resolve(null);
      turnState.steer = undefined;
      for (const segment of turnState.segments) {
        // Any tool still marked running did not finish.
        for (const p of segment.parts) {
          if (p.type === "tool" && (p.state === "running" || p.state === "awaiting-approval")) {
            p.state = status === "completed" ? "completed" : "error";
            this.broadcast({ type: "part", conversationId: cid, messageId: segment.id, part: p });
          }
          if (p.type === "reasoning") p.done = true;
        }
        segment.status = status;
      }
      // A part of the reply that a steered message split off before anything was said is dropped.
      const dropped = turnState.segments.filter((m, i) => i < turnState.segments.length - 1 && m.parts.length === 0);
      if (dropped.length) {
        conv.messages = conv.messages.filter((m) => !dropped.includes(m));
        turnState.segments = turnState.segments.filter((m) => !dropped.includes(m));
      }
      // The provider has seen everything up to the first message still waiting in the queue.
      const firstQueued = conv.messages.findIndex((m) => m.queued);
      if (nativeIdSet || conv.native[pid]) conv.seen[pid] = firstQueued < 0 ? conv.messages.length : firstQueued;
      conv.updatedAt = Date.now();
      this.running.delete(cid);
      const queued = this.queues.get(cid) ?? [];
      this.queues.delete(cid);
      const alive = this.store.get(cid) === conv;
      // Stopping a reply also drops what was queued behind it (the app puts it back in the composer).
      const next = status === "interrupted" || !alive ? [] : queued;
      if (status === "interrupted") for (const q of queued) conv.messages = conv.messages.filter((m) => m !== q.userMsg);
      for (const q of next) delete q.userMsg.queued;
      for (const m of dropped) this.broadcast({ type: "message.removed", conversationId: cid, messageId: m.id });
      for (const segment of turnState.segments) this.broadcast({ type: "turn.end", conversationId: cid, messageId: segment.id, status, error });
      if (status === "interrupted") for (const q of queued) this.broadcast({ type: "message.removed", conversationId: cid, messageId: q.userMsg.id });
      // Deleted while the reply was running: do not resurrect it in open UIs.
      if (alive) this.broadcast({ type: "conversation", meta: this.metaWithStatus(conv) });
      // Start the queued messages before anything is awaited: startTurn marks the chat as running
      // at once, so a message sent in between is queued behind them instead of racing them.
      const starting = next.length ? this.startTurn(conv, next) : null;
      await this.store.save(conv).catch(() => {});
      await starting?.catch((e) => console.warn(`[twinmind] could not send queued messages: ${e?.message ?? e}`));
    }
  }

  /** Answer (or, with null, dismiss) an open question. */
  answer(questionPartId: string, answers: Record<string, string[]> | null): boolean {
    const q = this.inputs.get(questionPartId);
    if (!q) return false;
    if (answers !== null) {
      // Only string arrays, bounded.
      const clean: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(answers ?? {}).slice(0, 10)) {
        if (Array.isArray(v)) clean[String(k).slice(0, 2000)] = v.filter((x) => typeof x === "string").map((x) => x.slice(0, 5000)).slice(0, 20);
      }
      q.resolve(clean);
    } else q.resolve(null);
    return true;
  }

  approve(approvalId: string, decision: ApprovalDecision): boolean {
    const a = this.approvals.get(approvalId);
    if (!a) return false;
    if (!["allow", "allow-session", "deny"].includes(decision)) return false;
    a.resolve(decision);
    return true;
  }

  interrupt(conversationId: string): boolean {
    const r = this.running.get(conversationId);
    if (!r) return false;
    r.controller.abort();
    return true;
  }

  interruptAll(): void {
    for (const r of this.running.values()) r.controller.abort();
  }
}

function titleFrom(text: string, attachments: StoredUpload[]): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t) return t.length > 60 ? t.slice(0, 57) + "…" : t;
  if (attachments.length) return attachments[0].name;
  return "New chat";
}
