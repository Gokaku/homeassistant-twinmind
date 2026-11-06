import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AuthState, ChatMessage, ModeInfo, ModelInfo, Part, ToolPart } from "../protocol.js";
import { CodexRpc, findCodexBinary, type ServerRequestMsg } from "./codex-rpc.js";
import { HA_TOOLS } from "../hass/tools.js";
import { HA_INSTRUCTIONS, HA_MCP_SERVER } from "./instructions.js";
import { agentEnv } from "./env.js";
import { stringifyOutput, truncate } from "./tooltext.js";
import type { NativeSession, Provider, TurnContext } from "./types.js";

type Policy = { approvalPolicy: string; sandbox: "read-only" | "workspace-write" | "danger-full-access" };

const MODES: (ModeInfo & Policy)[] = [
  {
    id: "read-only",
    label: "Read only",
    description: "Can read files; asks before any change",
    risk: "safe",
    approvalPolicy: "on-request",
    sandbox: "read-only",
  },
  {
    id: "untrusted",
    label: "Ask",
    description: "Asks before running anything that is not a known-safe read",
    risk: "normal",
    approvalPolicy: "untrusted",
    sandbox: "workspace-write",
  },
  {
    id: "auto",
    label: "Auto",
    description: "Edits /config and runs sandboxed commands without asking; asks for HA changes",
    risk: "elevated",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  },
  {
    id: "full-access",
    label: "Full access",
    description: "No sandbox, no questions, as root, including HA changes",
    risk: "danger",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  },
];



interface ActiveTurn {
  ctx: TurnContext;
  turnId: string | null;
  parts: Map<string, ToolPart>;
  textItems: Set<string>;
  flush: Map<string, NodeJS.Timeout>;
  error: string | null;
  retrying: boolean;
  resolve: (status: "completed" | "interrupted") => void;
  reject: (e: Error) => void;
}

/**
 * Codex reads `.codex/config.toml` from the working directory and its parents, and starts
 * MCP servers defined there as plain commands, outside its sandbox. Anything that can write
 * /config (an assistant in an "edit without asking" mode, a custom integration, ...) could
 * plant one, so Codex is not started while such a file exists.
 */
export function findProjectCodexConfig(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, ".codex", "config.toml");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The sandbox for one turn, in the shape turn/start expects. It must be sent with every turn:
 * thread/resume ignores sandbox overrides for a thread the app-server already has loaded,
 * so without this a chat that once ran in Full access would stay unsandboxed.
 */
export function sandboxPolicyFor(mode: string, cwd: string): Record<string, unknown> {
  const sandbox = (MODES.find((m) => m.id === mode) ?? MODES[1]).sandbox;
  if (sandbox === "danger-full-access") return { type: "dangerFullAccess" };
  if (sandbox === "read-only") return { type: "readOnly", networkAccess: false };
  return { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

export class CodexProvider implements Provider {
  readonly id = "codex" as const;
  readonly label = "Codex";
  readonly modes: ModeInfo[] = MODES.map(({ id, label, description, risk }) => ({ id, label, description, risk }));
  readonly defaultMode = "untrusted";
  private rpc: CodexRpc | null = null;
  private turns = new Map<string, ActiveTurn>(); // by threadId
  private login: { loginId: string; url: string; code: string } | null = null;
  private modelCache: { at: number; models: ModelInfo[] } | null = null;

  constructor(private readonly opts: { cwd: string; bin?: string | null }) {}

  private client(): CodexRpc {
    if (this.rpc) return this.rpc;
    const bin = this.opts.bin ?? findCodexBinary();
    if (!bin) throw new Error("Codex binary not found");
    // Codex reads the MCP bearer secret from its environment; nothing else secret is passed.
    const rpc = new CodexRpc(bin, () => agentEnv({ TWINMIND_MCP_SECRET: process.env.TWINMIND_MCP_SECRET }));
    rpc.on("notification", (method: string, params: any) => this.onNotification(method, params));
    rpc.on("request", (req: ServerRequestMsg) =>
      this.onRequest(req).catch((e) => console.warn(`[twinmind] Codex request ${req.method} failed: ${e?.message ?? e}`)),
    );
    rpc.on("exit", (err: Error) => {
      for (const t of this.turns.values()) t.reject(err);
      this.turns.clear();
      this.login = null;
    });
    this.rpc = rpc;
    return rpc;
  }

  async auth(): Promise<AuthState> {
    if (this.login) return { state: "pending", flow: "device-code", url: this.login.url, code: this.login.code };
    let rpc: CodexRpc;
    try {
      rpc = this.client();
    } catch (e: any) {
      return { state: "unavailable", reason: e.message };
    }
    const r = await rpc.call("account/read", {}, 15_000);
    const a = r?.account;
    if (!a) return { state: "signed-out" };
    if (a.type === "chatgpt") return { state: "signed-in", account: a.email ?? undefined, plan: a.planType ?? undefined };
    return { state: "signed-in", account: a.type === "apiKey" ? "API key" : a.type };
  }

  async models(): Promise<ModelInfo[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < 10 * 60_000) return this.modelCache.models;
    const base: ModelInfo[] = [{ id: "", label: "Default", description: "Codex's default model" }];
    try {
      const r = await this.client().call("model/list", {}, 15_000);
      const list: ModelInfo[] = (r?.data ?? [])
        .filter((m: any) => !m.hidden)
        .map((m: any) => ({ id: m.model ?? m.id, label: m.displayName ?? m.id, description: m.description }));
      this.modelCache = { at: Date.now(), models: [...base, ...list] };
      return this.modelCache.models;
    } catch {
      return base;
    }
  }

  async startLogin(): Promise<AuthState> {
    await this.cancelLogin();
    const r = await this.client().call("account/login/start", { type: "chatgptDeviceCode" });
    if (r?.type !== "chatgptDeviceCode") throw new Error("Codex did not start a device-code sign-in");
    this.login = { loginId: r.loginId, url: r.verificationUrl, code: r.userCode };
    return { state: "pending", flow: "device-code", url: r.verificationUrl, code: r.userCode };
  }

  async cancelLogin(): Promise<void> {
    if (!this.login) return;
    const id = this.login.loginId;
    this.login = null;
    await this.rpc?.call("account/login/cancel", { loginId: id }, 10_000).catch(() => {});
  }

  async logout(): Promise<void> {
    await this.client().call("account/logout", {});
  }

  async run(ctx: TurnContext): Promise<{ status: "completed" | "interrupted" }> {
    const planted = findProjectCodexConfig(ctx.cwd);
    if (planted) {
      throw new Error(
        `Codex was not started because ${planted} exists. Codex runs commands listed in that file outside its sandbox. Remove or rename it if you did not create it on purpose.`,
      );
    }
    const rpc = this.client();
    const policy = MODES.find((m) => m.id === ctx.mode) ?? MODES[1];
    const common = {
      cwd: ctx.cwd,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
      model: ctx.model || null,
      developerInstructions: HA_INSTRUCTIONS,
      // Twinmind's Home Assistant tools; the bearer secret is read from the app-server's environment.
      config: ctx.mcp
        ? { mcp_servers: { [HA_MCP_SERVER]: {
                url: ctx.mcp.url,
                bearer_token_env_var: "TWINMIND_MCP_SECRET",
                // Changes wait for the user's approval in the app: give them time.
                tool_timeout_sec: 1800,
              } } }
        : undefined,
    };
    let started: any = null;
    if (ctx.nativeId) {
      try {
        started = await rpc.call("thread/resume", { threadId: ctx.nativeId, excludeTurns: true, ...common });
      } catch (e: any) {
        // A thread whose first turn never ran was never written to disk and cannot be resumed.
        // Start over instead of failing this chat forever.
        if (!/no rollout|not found/i.test(String(e?.message))) throw e;
        ctx.emit({
          type: "part",
          part: { type: "notice", id: randomUUID(), level: "warning", text: "Codex could not find its earlier thread for this chat and started a new one; it may miss earlier context." },
        });
      }
    }
    started ??= await rpc.call("thread/start", { ...common, threadSource: "twinmind" });
    const threadId: string = started.thread.id;
    if (this.turns.has(threadId)) throw new Error("This Codex thread is already busy");

    const input: any[] = [{ type: "text", text: this.promptWithFiles(ctx), text_elements: [] }];
    for (const a of ctx.attachments) if (a.mediaType.startsWith("image/")) input.push({ type: "localImage", path: a.path });

    return new Promise<{ status: "completed" | "interrupted" }>((resolve, reject) => {
      const turn: ActiveTurn = {
        ctx,
        turnId: null,
        parts: new Map(),
        textItems: new Set(),
        flush: new Map(),
        error: null,
        retrying: false,
        resolve: (s) => (cleanup(), resolve({ status: s })),
        reject: (e) => (cleanup(), reject(e)),
      };
      const onAbort = () => {
        if (turn.turnId) void rpc.call("turn/interrupt", { threadId, turnId: turn.turnId }, 10_000).catch(() => {});
        // If Codex does not confirm promptly, stop waiting.
        setTimeout(() => this.turns.get(threadId) === turn && turn.resolve("interrupted"), 5000).unref();
      };
      const cleanup = () => {
        ctx.signal.removeEventListener("abort", onAbort);
        for (const t of turn.flush.values()) clearTimeout(t);
        this.turns.delete(threadId);
      };
      this.turns.set(threadId, turn);
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      rpc
        .call("turn/start", {
          threadId,
          input,
          approvalPolicy: policy.approvalPolicy,
          sandboxPolicy: sandboxPolicyFor(ctx.mode, ctx.cwd),
          model: ctx.model || null,
        })
        .then((r) => {
          turn.turnId = r?.turn?.id ?? null;
          // Only now is the thread real (persisted by Codex): remember it for this chat.
          ctx.emit({ type: "native-id", id: threadId });
          if (ctx.signal.aborted) onAbort();
        })
        .catch((e) => turn.reject(e));
    });
  }

  private promptWithFiles(ctx: TurnContext): string {
    const others = ctx.attachments.filter((a) => !a.mediaType.startsWith("image/"));
    if (!others.length) return ctx.prompt;
    return `${ctx.prompt}\n\nAttached files:\n${others.map((a) => `- ${a.path} (${a.name}, ${a.mediaType})`).join("\n")}`;
  }

  private toolFromItem(item: any): ToolPart | null {
    const state = (s: string | undefined): ToolPart["state"] =>
      s === "failed" ? "error" : s === "declined" ? "denied" : s === "completed" ? "completed" : "running";
    switch (item.type) {
      case "commandExecution":
        return {
          type: "tool",
          id: item.id,
          name: "shell",
          kind: "command",
          title: truncate(item.command ?? "command", 160),
          input: { command: item.command, cwd: item.cwd },
          output: item.aggregatedOutput ? truncate(item.aggregatedOutput, 20_000) : undefined,
          state: state(item.status),
        };
      case "fileChange": {
        const changes: any[] = item.changes ?? [];
        return {
          type: "tool",
          id: item.id,
          name: "apply_patch",
          kind: "file",
          title: changes.map((c) => `${c.kind === "add" ? "+" : c.kind === "delete" ? "−" : "~"} ${c.path}`).join(", ") || "file change",
          input: { changes: changes.map((c) => ({ path: c.path, kind: c.kind })) },
          output: truncate(changes.map((c) => c.diff).filter(Boolean).join("\n"), 20_000) || undefined,
          state: state(item.status),
        };
      }
      case "mcpToolCall": {
        const ha = item.server === HA_MCP_SERVER ? HA_TOOLS.find((t) => t.name === item.tool) : undefined;
        let title = `${item.server} · ${item.tool}`;
        if (ha) {
          try {
            title = truncate(`${ha.title}: ${ha.summary(item.arguments ?? {})}`, 160);
          } catch {
            title = ha.title;
          }
        }
        return {
          type: "tool",
          id: item.id,
          name: `${item.server}.${item.tool}`,
          kind: ha ? "ha" : "mcp",
          title,
          input: item.arguments,
          output: item.result ? truncate(stringifyOutput(item.result.content ?? item.result), 20_000) : item.error?.message,
          state: item.error ? "error" : state(item.status),
        };
      }
      case "dynamicToolCall":
        return {
          type: "tool",
          id: item.id,
          name: item.tool,
          kind: "other",
          title: item.tool,
          input: item.arguments,
          state: item.success === false ? "error" : state(item.status),
        };
      case "webSearch":
        return {
          type: "tool",
          id: item.id,
          name: "web_search",
          kind: "web",
          title: item.query || "Web search",
          input: { query: item.query },
          state: "completed",
        };
      default:
        return null;
    }
  }

  private onNotification(method: string, p: any) {
    if (method === "account/login/completed") {
      this.login = null;
      return;
    }
    const turn = p?.threadId ? this.turns.get(p.threadId) : undefined;
    if (!turn) return;
    const { emit } = turn.ctx;
    if (turn.retrying && (method.startsWith("item/") || method === "turn/completed")) {
      turn.retrying = false;
      emit({ type: "part", part: { type: "notice", id: "retry", level: "info", text: "Connection recovered after a retry." } });
    }
    switch (method) {
      case "turn/started":
        turn.turnId = p.turn?.id ?? turn.turnId;
        break;
      case "item/agentMessage/delta":
        turn.textItems.add(p.itemId);
        emit({ type: "text-delta", partId: p.itemId, delta: p.delta });
        break;
      case "item/reasoning/summaryTextDelta":
        emit({ type: "reasoning-delta", partId: `${p.itemId}:r`, delta: p.delta });
        break;
      case "item/reasoning/summaryPartAdded":
        emit({ type: "reasoning-delta", partId: `${p.itemId}:r`, delta: "\n\n" });
        break;
      case "item/commandExecution/outputDelta": {
        const part = turn.parts.get(p.itemId);
        if (!part) break;
        part.output = truncate((part.output ?? "") + p.delta, 20_000);
        // Throttle: at most one UI update per 250 ms per command.
        if (!turn.flush.has(p.itemId)) {
          turn.flush.set(
            p.itemId,
            setTimeout(() => {
              turn.flush.delete(p.itemId);
              // Send the card as it is now, never an older copy: the command may have
              // completed in the meantime.
              const latest = turn.parts.get(p.itemId);
              if (latest) emit({ type: "part", part: { ...latest } });
            }, 250),
          );
        }
        break;
      }
      case "item/started":
      case "item/completed": {
        const item = p.item;
        if (method === "item/completed" && item?.id) {
          const pending = turn.flush.get(item.id);
          if (pending) clearTimeout(pending), turn.flush.delete(item.id);
        }
        if (item?.type === "agentMessage") {
          if (method === "item/completed" && !turn.textItems.has(item.id) && item.text) {
            emit({ type: "part", part: { type: "text", id: item.id, text: item.text } });
          }
          break;
        }
        const tool = this.toolFromItem(item);
        if (tool) {
          const prev = turn.parts.get(tool.id);
          if (prev?.approval) tool.approval = prev.approval;
          if (prev?.state === "awaiting-approval" && tool.state === "running") tool.state = "awaiting-approval";
          turn.parts.set(tool.id, tool);
          emit({ type: "part", part: tool });
        }
        break;
      }
      case "turn/plan/updated": {
        const status = (s: string) => (s === "inProgress" ? "in_progress" : s === "completed" ? "completed" : "pending");
        emit({
          type: "part",
          part: { type: "todo", id: "todo", items: (p.plan ?? []).map((s: any) => ({ text: s.step, status: status(s.status) })) },
        });
        break;
      }
      case "error":
        if (!p.willRetry) turn.error = p.error?.message ?? "Codex error";
        else {
          turn.retrying = true;
          emit({ type: "part", part: { type: "notice", id: "retry", level: "warning", text: `Retrying: ${p.error?.message ?? ""}` } });
        }
        break;
      case "turn/completed": {
        const t = p.turn;
        if (t?.status === "failed") turn.reject(new Error(t.error?.message ?? turn.error ?? "Codex turn failed"));
        else if (t?.status === "interrupted") turn.resolve("interrupted");
        else turn.resolve("completed");
        break;
      }
    }
  }

  private async onRequest(req: ServerRequestMsg) {
    const rpc = this.rpc!;
    const p = req.params ?? {};
    const turn = p.threadId ? this.turns.get(p.threadId) : p.conversationId ? this.turns.get(p.conversationId) : undefined;
    if (!turn) {
      // No UI to ask: be safe and decline.
      return this.declineUnknown(req);
    }
    const ask = async (kind: "command" | "file", title: string, input: unknown, reason?: string) => {
      const toolPartId = p.itemId ?? p.callId ?? randomUUID();
      const existing = turn.parts.get(toolPartId);
      const decision = await turn.ctx.requestApproval({
        toolPartId,
        name: kind === "command" ? "shell" : "apply_patch",
        kind,
        title: existing?.title ?? title,
        input: existing?.input ?? input,
        reason: reason ?? undefined,
      });
      return decision;
    };
    try {
      switch (req.method) {
        case "item/commandExecution/requestApproval": {
          const d = await ask("command", truncate(p.command ?? "command", 160), { command: p.command, cwd: p.cwd }, p.reason);
          return rpc.respond(req.id, { decision: d === "allow" ? "accept" : d === "allow-session" ? "acceptForSession" : "decline" });
        }
        case "item/fileChange/requestApproval": {
          const d = await ask("file", "Apply file changes", undefined, p.reason ?? (p.grantRoot ? `Write access to ${p.grantRoot}` : undefined));
          return rpc.respond(req.id, { decision: d === "allow" ? "accept" : d === "allow-session" ? "acceptForSession" : "decline" });
        }
        case "item/permissions/requestApproval": {
          const d = await ask("command", "Extra permissions", p.permissions, p.reason);
          if (d === "deny") return rpc.respond(req.id, { permissions: {}, scope: "turn" });
          const granted: any = {};
          if (p.permissions?.network) granted.network = p.permissions.network;
          if (p.permissions?.fileSystem) granted.fileSystem = p.permissions.fileSystem;
          return rpc.respond(req.id, { permissions: granted, scope: d === "allow-session" ? "session" : "turn" });
        }
        case "execCommandApproval": {
          const cmd = Array.isArray(p.command) ? p.command.join(" ") : String(p.command ?? "command");
          const d = await ask("command", truncate(cmd, 160), { command: cmd }, p.reason);
          return rpc.respond(req.id, { decision: d === "allow" ? "approved" : d === "allow-session" ? "approved_for_session" : { denied: { rejection: "The user declined." } } });
        }
        case "applyPatchApproval": {
          const d = await ask("file", "Apply file changes", p.fileChanges, p.reason);
          return rpc.respond(req.id, { decision: d === "allow" ? "approved" : d === "allow-session" ? "approved_for_session" : { denied: { rejection: "The user declined." } } });
        }
        default:
          return this.declineUnknown(req);
      }
    } catch (e: any) {
      rpc.respondError(req.id, e?.message ?? "Failed");
    }
  }

  private declineUnknown(req: ServerRequestMsg) {
    const rpc = this.rpc!;
    switch (req.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return rpc.respond(req.id, { decision: "decline" });
      case "item/permissions/requestApproval":
        return rpc.respond(req.id, { permissions: {}, scope: "turn" });
      case "mcpServer/elicitation/request":
        // Twinmind's own server enforces approval itself; anything else is declined.
        if (req.params?.serverName === HA_MCP_SERVER) return rpc.respond(req.id, { action: "accept", content: {}, _meta: null });
        return rpc.respond(req.id, { action: "decline", content: null, _meta: null });
      case "item/tool/requestUserInput":
        return rpc.respond(req.id, { answers: {} });
      case "execCommandApproval":
      case "applyPatchApproval":
        return rpc.respond(req.id, { decision: "abort" });
      default:
        return rpc.respondError(req.id, `Twinmind does not support ${req.method}`);
    }
  }

  async listNative(): Promise<NativeSession[]> {
    const r = await this.client().call("thread/list", { limit: 50, cwd: this.opts.cwd });
    return (r?.data ?? []).map((t: any) => ({
      id: t.id,
      title: t.name || t.preview || "Codex thread",
      updatedAt: (t.updatedAt ?? t.createdAt ?? 0) * (t.updatedAt > 1e12 ? 1 : 1000),
      cwd: t.cwd,
    }));
  }

  async readNative(id: string): Promise<ChatMessage[]> {
    const r = await this.client().call("thread/read", { threadId: id, includeTurns: true });
    const out: ChatMessage[] = [];
    for (const turn of r?.thread?.turns ?? []) {
      let assistant: ChatMessage | null = null;
      for (const item of turn.items ?? []) {
        if (item.type === "userMessage") {
          const text = (item.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
          if (text.trim())
            out.push({ id: item.id, role: "user", provider: "codex", createdAt: Date.now(), parts: [{ type: "text", id: randomUUID(), text }] });
          continue;
        }
        const part: Part | null =
          item.type === "agentMessage" && item.text ? { type: "text", id: item.id, text: item.text } : this.toolFromItem(item);
        if (!part) continue;
        if (!assistant) {
          assistant = { id: randomUUID(), role: "assistant", provider: "codex", createdAt: Date.now(), parts: [], status: "completed" };
          out.push(assistant);
        }
        assistant.parts.push(part);
      }
    }
    return out;
  }

  async dispose(): Promise<void> {
    await this.rpc?.stop();
  }
}
