import { randomBytes, randomUUID } from "node:crypto";
import { buildPrompt } from "./handoff.js";
import type { GateDecision, McpEndpoint, ToolGate } from "./hass/mcp.js";
import { haPolicy } from "./hass/policy.js";
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
import type { Provider, ProviderEvent, TurnContext } from "./providers/types.js";
import { isValidId, toMeta, type ConversationStore } from "./store.js";
import type { StoredUpload, UploadStore } from "./uploads.js";

type SendMessage = Extract<ClientMessage, { type: "send" }>;

interface RunningTurn {
  controller: AbortController;
  messageId: string;
  provider: ProviderId;
  mode: string;
  assistant?: ChatMessage;
  requestApproval?: TurnContext["requestApproval"];
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
  /** conversation id -> MCP token, and back. Tokens live as long as the process. */
  private tokens = new Map<string, string>();
  private tokenOwners = new Map<string, string>();
  /** conversation id -> HA tools the user allowed for the rest of the session. */
  private sessionAllowed = new Map<string, Set<string>>();
  private mcp: McpEndpoint | null = null;

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
    const policy = haPolicy(turn.provider, turn.mode);
    if (policy === "allow") return { ok: true };
    if (policy === "read-only")
      return { ok: false, reason: `This chat is in a read-only mode (${turn.mode}). Describe the change instead; the user can switch modes to apply it.` };
    if (policy === "deny") return { ok: false, reason: `Changes are not allowed in this mode (${turn.mode}).` };
    if (this.sessionAllowed.get(cid)?.has(tool.name)) return { ok: true };
    if (!turn.requestApproval) return { ok: false, reason: "No one is there to approve this right now." };
    // Put the approval on the assistant's own card for this tool call, if we can find it.
    const part = [...(turn.assistant?.parts ?? [])]
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
      reason: tool.title,
      signal,
    });
    if (signal?.aborted) return { ok: false, reason: "The tool call was cancelled before it was approved." };
    if (decision === "deny") return { ok: false, reason: "The user declined this change." };
    if (decision === "allow-session") {
      if (!this.sessionAllowed.has(cid)) this.sessionAllowed.set(cid, new Set());
      this.sessionAllowed.get(cid)!.add(tool.name);
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

  /** Validate and start a turn. Resolves once the turn has started (not when it ends). */
  async send(msg: SendMessage): Promise<void> {
    const provider = this.providers.get(msg.provider);
    if (!provider) throw new Error(`Unknown provider: ${msg.provider}`);
    if (!provider.modes.some((m) => m.id === msg.mode)) throw new Error(`Unknown mode for ${provider.label}: ${msg.mode}`);
    const text = typeof msg.text === "string" ? msg.text.slice(0, 100_000) : "";
    const attachmentIds = Array.isArray(msg.attachments) ? msg.attachments.slice(0, 10) : [];
    if (!text.trim() && attachmentIds.length === 0) throw new Error("Message is empty");
    const model = typeof msg.model === "string" && msg.model.length < 100 ? msg.model : undefined;

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
    if (this.running.has(conv.id)) throw new Error("A reply is still running in this chat");

    const history = conv.messages.slice();
    const userMsg: ChatMessage = {
      id: randomUUID(),
      role: "user",
      provider: msg.provider,
      model,
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
    this.store.addMessage(conv, userMsg);
    if (conv.title === "New chat" && text.trim()) conv.title = titleFrom(text, attachments);

    const assistant: ChatMessage = {
      id: randomUUID(),
      role: "assistant",
      provider: msg.provider,
      model,
      mode: msg.mode,
      createdAt: Date.now(),
      parts: [],
      status: "streaming",
    };
    this.store.addMessage(conv, assistant);
    conv.provider = msg.provider;

    const controller = new AbortController();
    this.running.set(conv.id, { controller, messageId: assistant.id, provider: msg.provider, mode: msg.mode, assistant });
    this.broadcast({ type: "conversation", meta: this.metaWithStatus(conv), clientRequestId: msg.clientRequestId });
    this.broadcast({ type: "message", conversationId: conv.id, message: userMsg });
    this.broadcast({ type: "message", conversationId: conv.id, message: assistant });
    // A failed save (disk full, ...) must not leave the chat marked as running forever:
    // the turn still runs, and the end of the turn saves again.
    await this.store.save(conv).catch((e) => console.warn(`[twinmind] could not save conversation ${conv.id}: ${e?.message ?? e}`));

    const prompt = buildPrompt(conv, history, msg.provider, text || "(see attached files)");
    void this.runTurn(conv, provider, assistant, prompt, attachments, msg.mode, model, controller);
  }

  private async runTurn(
    conv: Conversation,
    provider: Provider,
    assistant: ChatMessage,
    prompt: string,
    attachments: StoredUpload[],
    mode: string,
    model: string | undefined,
    controller: AbortController,
  ): Promise<void> {
    const cid = conv.id;
    const mid = assistant.id;
    const pid = provider.id;
    let nativeIdSet = false;

    const upsert = (incoming: Part) => {
      const i = assistant.parts.findIndex((p) => p.id === incoming.id);
      let part = incoming;
      const prev = i >= 0 ? assistant.parts[i] : undefined;
      // Providers re-send tool parts as they progress; keep the approval we attached.
      if (prev?.type === "tool" && part.type === "tool" && prev.approval && !part.approval) {
        part = { ...part, approval: prev.approval };
        if (prev.state === "awaiting-approval" && !prev.approval.decision && part.state === "running") {
          part.state = "awaiting-approval";
        }
      }
      if (i >= 0) assistant.parts[i] = part;
      else assistant.parts.push(part);
      this.broadcast({ type: "part", conversationId: cid, messageId: mid, part });
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
          let p = assistant.parts.find((x) => x.id === e.partId);
          if (!p) {
            p = kind === "text" ? { type: "text", id: e.partId, text: "" } : { type: "reasoning", id: e.partId, text: "" };
            assistant.parts.push(p);
            this.broadcast({ type: "part", conversationId: cid, messageId: mid, part: { ...p } });
          }
          if (p.type === "text" || p.type === "reasoning") p.text += e.delta;
          this.broadcast({
            type: kind === "text" ? "text.delta" : "reasoning.delta",
            conversationId: cid,
            messageId: mid,
            partId: e.partId,
            delta: e.delta,
          });
          break;
        }
        case "part":
          upsert(e.part);
          break;
      }
    };

    const requestApproval: import("./providers/types.js").TurnContext["requestApproval"] = (req) =>
      new Promise<ApprovalDecision>((resolve) => {
        if (controller.signal.aborted || req.signal?.aborted) return resolve("deny");
        const approvalId = randomUUID();
        const existing = assistant.parts.find((p) => p.id === req.toolPartId) as ToolPart | undefined;
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
          const current = assistant.parts.find((p) => p.id === req.toolPartId) as ToolPart | undefined;
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
        this.approvals.set(approvalId, { conversationId: cid, messageId: mid, partId: req.toolPartId, resolve: done });
      });

    const turnState = this.running.get(cid);
    if (turnState) turnState.requestApproval = requestApproval;

    let status: "completed" | "interrupted" | "failed" = "completed";
    let error: string | undefined;
    try {
      const r = await provider.run({
        prompt,
        attachments,
        mode,
        model,
        cwd: this.cwd,
        nativeId: conv.native[pid],
        mcp: this.mcp ? { url: this.mcp.url(this.mcpToken(cid)), secret: this.mcp.secret } : undefined,
        signal: controller.signal,
        emit,
        requestApproval,
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
      // Any tool still marked running did not finish.
      for (const p of assistant.parts) {
        if (p.type === "tool" && (p.state === "running" || p.state === "awaiting-approval")) {
          p.state = status === "completed" ? "completed" : "error";
          this.broadcast({ type: "part", conversationId: cid, messageId: mid, part: p });
        }
        if (p.type === "reasoning") p.done = true;
      }
      assistant.status = status;
      if (nativeIdSet || conv.native[pid]) conv.seen[pid] = conv.messages.length;
      conv.updatedAt = Date.now();
      this.running.delete(cid);
      await this.store.save(conv).catch(() => {});
      this.broadcast({ type: "turn.end", conversationId: cid, messageId: mid, status, error });
      // Deleted while the reply was running: do not resurrect it in open UIs.
      if (this.store.get(cid) === conv) this.broadcast({ type: "conversation", meta: this.metaWithStatus(conv) });
    }
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
