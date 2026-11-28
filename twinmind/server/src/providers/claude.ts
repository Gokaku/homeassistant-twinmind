import {
  getSessionMessages,
  listSessions,
  query,
  type CanUseTool,
  type EffortLevel,
  type ModelInfo as SdkModelInfo,
  type PermissionMode,
  type PermissionUpdate,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { AuthState, ChatMessage, ModeInfo, ModelInfo, Part, ToolKind } from "../protocol.js";
import { HA_TOOLS } from "../hass/tools.js";
import { HA_INSTRUCTIONS, HA_MCP_SERVER } from "./instructions.js";
import { agentEnv } from "./env.js";
import { effortLabel, pickModel } from "./models.js";
import { projectContext } from "./project.js";
import { describeTool, stringifyOutput, truncate } from "./tooltext.js";
import type { NativeSession, Provider, TurnContext } from "./types.js";
import type { StoredUpload } from "../uploads.js";

const require = createRequire(import.meta.url);

/** Locate the native `claude` binary that ships with the Agent SDK. */
export function findClaudeBinary(): string | null {
  if (process.env.TWINMIND_CLAUDE_BIN) return process.env.TWINMIND_CLAUDE_BIN;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const musl = fs.existsSync("/etc/alpine-release");
  const names = musl
    ? [`linux-${arch}-musl`, `linux-${arch}`]
    : process.platform === "darwin"
      ? [`darwin-${arch}`]
      : [`linux-${arch}`, `linux-${arch}-musl`];
  for (const n of names) {
    try {
      const pkg = require.resolve(`@anthropic-ai/claude-agent-sdk-${n}/package.json`);
      const bin = path.join(path.dirname(pkg), "claude");
      if (fs.existsSync(bin)) return bin;
    } catch {
      /* not installed */
    }
  }
  return null;
}

const MODES: ModeInfo[] = [
  { id: "default", label: "Ask", description: "Asks before edits and commands", risk: "normal" },
  { id: "plan", label: "Plan", description: "Read-only: explores and proposes a plan", risk: "safe" },
  { id: "acceptEdits", label: "Accept edits", description: "Edits /config without asking (config can run code); asks for commands and HA changes", risk: "elevated" },
  { id: "auto", label: "Auto", description: "A safety classifier reviews every action, HA changes included, and allows or blocks it; asks only for sensitive HA commands (users, tokens, Supervisor, backups)", risk: "elevated" },
  { id: "dontAsk", label: "Don't ask", description: "Never asks; denies anything not pre-approved", risk: "safe" },
  { id: "bypassPermissions", label: "Bypass", description: "Runs everything without asking, as root, including HA changes", risk: "danger" },
];

const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** Used only if Claude Code cannot be asked for its model list. */
const FALLBACK_MODELS: ModelInfo[] = [
  { id: "opus", label: "Opus", isDefault: true },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
].map((m) => withEfforts(m, ALL_EFFORTS));

function withEfforts(m: ModelInfo, levels: string[]): ModelInfo {
  if (!levels.length) return m;
  return {
    ...m,
    efforts: levels.map((id) => ({ id, label: effortLabel(id) })),
    // The API's own default effort.
    defaultEffort: levels.includes("high") ? "high" : levels[levels.length - 1],
  };
}

/**
 * Twinmind's model list from Claude Code's supportedModels(). Claude Code's "Default" row
 * stands for one of the real models: that model is marked as the default instead, so the
 * user always picks (and sees) an exact model.
 */
export function modelsFromSdk(list: SdkModelInfo[]): ModelInfo[] {
  const def = list.find((m) => m.value === "default");
  const defaultId = def?.resolvedModel;
  const out: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const m of list) {
    if (m.value === "default") continue;
    const resolved = m.resolvedModel ?? m.value;
    if (seen.has(resolved)) continue; // an alias and its full id: list the model once
    seen.add(resolved);
    out.push(
      withEfforts(
        { id: m.value, label: m.displayName || m.value, description: m.description || undefined, isDefault: !!defaultId && resolved === defaultId },
        m.supportsEffort ? (m.supportedEffortLevels ?? []) : [],
      ),
    );
  }
  if (def && defaultId && !seen.has(defaultId)) {
    out.unshift(withEfforts({ id: defaultId, label: def.description || defaultId, isDefault: true }, def.supportsEffort ? (def.supportedEffortLevels ?? []) : []));
  }
  if (out.length && !out.some((m) => m.isDefault)) out[0].isDefault = true;
  return out;
}



const HA_PREFIX = `mcp__${HA_MCP_SERVER}__`;

/** Card title for a tool call: HA tools use their own one-line summary. */
function toolTitle(name: string, input: any): string {
  if (name.startsWith(HA_PREFIX)) {
    const t = HA_TOOLS.find((x) => x.name === name.slice(HA_PREFIX.length));
    if (t) {
      try {
        return truncate(`${t.title}: ${t.summary(input ?? {})}`, 160);
      } catch {
        return t.title;
      }
    }
  }
  return describeTool(name, input);
}

const kindOf = (name: string): ToolKind => {
  if (name.startsWith(HA_PREFIX)) return "ha";
  if (name === "Bash" || name === "BashOutput" || name === "KillShell") return "command";
  if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(name)) return "file";
  if (name === "Read") return "read";
  if (name === "Grep" || name === "Glob") return "search";
  if (name === "WebFetch" || name === "WebSearch") return "web";
  if (name === "Task" || name === "Agent") return "agent";
  if (name.startsWith("mcp__")) return "mcp";
  return "other";
};

const stripAnsi = (s: string) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC (hyperlinks)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\x1b[@-_]/g, "");

/** Kill a detached child and everything in its process group. */
function killGroup(proc: ChildProcess) {
  try {
    if (proc.pid) process.kill(-proc.pid, "SIGTERM");
  } catch {
    proc.kill();
  }
}

/** "Always" means for this conversation only: never write rules to settings files. */
/**
 * Thinking with readable summaries. Without an explicit display, Claude Code asks the API for
 * thinking without its text (verified with claude 2.1.318), so the UI's "Thinking" block stayed
 * empty. Models without adaptive thinking get Claude Code's fixed budget instead.
 */
export const THINKING = { type: "adaptive", display: "summarized" } as const;

export function sessionOnly(suggestions: PermissionUpdate[] | undefined): PermissionUpdate[] | undefined {
  return suggestions?.map((s) => ({ ...s, destination: "session" as const }));
}

/** A user message for Claude Code: images as content blocks, other files referenced by path. */
function userMessage(prompt: string, attachments: StoredUpload[], uuid: string): SDKUserMessage {
  const images = attachments.filter((a) => /^image\/(png|jpeg|gif|webp)$/.test(a.mediaType));
  const others = attachments.filter((a) => !images.includes(a));
  let text = prompt;
  if (others.length) {
    text += `\n\nAttached files (read them with your tools):\n${others.map((a) => `- ${a.path} (${a.name}, ${a.mediaType})`).join("\n")}`;
  }
  return {
    type: "user",
    uuid: uuid as `${string}-${string}-${string}-${string}-${string}`,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        ...images.map((img) => ({
          type: "image" as const,
          source: { type: "base64" as const, media_type: img.mediaType as "image/png", data: fs.readFileSync(img.path).toString("base64") },
        })),
        { type: "text" as const, text },
      ],
    },
  };
}


interface StreamState {
  /** Usage of the current API message (from message_start / message_delta). */
  usage?: { input: number; cacheRead: number; cacheWrite: number; output: number };
  contextWindow?: number;
  toolParts: Map<string, Extract<Part, { type: "tool" }>>;
  streamed: Set<string>;
  blockPart: Map<string, string>;
  current: string;
}

interface LoginState {
  proc: ChildProcess;
  url: string | null;
  output: string;
  exited: boolean;
}

export class ClaudeProvider implements Provider {
  readonly id = "claude" as const;
  readonly label = "Claude";
  readonly modes = MODES;
  readonly defaultMode = "default";
  private login: LoginState | null = null;
  private authCache: { at: number; value: AuthState } | null = null;
  private modelCache: { at: number; models: ModelInfo[] } | null = null;

  constructor(private readonly opts: { cwd: string; bin?: string | null }) {}

  private get bin() {
    return this.opts.bin ?? findClaudeBinary();
  }

  async models(): Promise<ModelInfo[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < 10 * 60_000) return this.modelCache.models;
    // Claude Code answers this without a prompt and without an API call (works signed out).
    async function* idle(): AsyncIterable<SDKUserMessage> {
      await new Promise(() => {});
    }
    let q: ReturnType<typeof query> | null = null;
    try {
      q = query({
        prompt: idle(),
        options: { cwd: this.opts.cwd, env: agentEnv(), pathToClaudeCodeExecutable: this.bin ?? undefined, settingSources: [] },
      });
      let timer: NodeJS.Timeout | undefined;
      const list = await Promise.race([
        q.supportedModels(),
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), 20_000))),
      ]).finally(() => clearTimeout(timer));
      const models = modelsFromSdk(list);
      if (!models.length) throw new Error("empty model list");
      this.modelCache = { at: Date.now(), models };
      return models;
    } catch {
      // Remember the failure for a minute: every turn asks for the list, and a Claude Code that
      // does not answer would otherwise delay each reply by the timeout.
      this.modelCache = { at: Date.now() - 9 * 60_000, models: FALLBACK_MODELS };
      return FALLBACK_MODELS;
    } finally {
      try {
        q?.close();
      } catch {
        /* already closed */
      }
    }
  }

  async auth(): Promise<AuthState> {
    if (this.login && !this.login.exited) {
      if (this.login.url) return { state: "pending", flow: "code-paste", url: this.login.url };
    }
    if (this.authCache && Date.now() - this.authCache.at < 10_000) return this.authCache.value;
    const bin = this.bin;
    if (!bin) return { state: "unavailable", reason: "Claude Code binary not found" };
    const value = await new Promise<AuthState>((resolve) => {
      const p = spawn(bin, ["auth", "status"], { env: agentEnv(), stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      const t = setTimeout(() => p.kill(), 10_000);
      p.on("error", (e) => (clearTimeout(t), resolve({ state: "unavailable", reason: e.message })));
      p.on("close", () => {
        clearTimeout(t);
        try {
          const j = JSON.parse(out);
          if (j.loggedIn) resolve({ state: "signed-in", account: j.email ?? j.account?.email, plan: j.subscriptionType });
          else resolve({ state: "signed-out" });
        } catch {
          resolve({ state: "signed-out" });
        }
      });
    });
    this.authCache = { at: Date.now(), value };
    return value;
  }

  async startLogin(): Promise<AuthState> {
    await this.cancelLogin();
    const bin = this.bin;
    if (!bin) throw new Error("Claude Code binary not found");
    // `claude auth login` needs a terminal; `script` gives it a pseudo-terminal.
    const cmd = `${JSON.stringify(bin)} auth login --claudeai`;
    const proc = spawn("script", ["-qfc", cmd, "/dev/null"], {
      env: agentEnv({ BROWSER: "/bin/false", TERM: "xterm-256color", COLUMNS: "500" }),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // own process group, so we can stop `script` and `claude` together
    });
    const state: LoginState = { proc, url: null, output: "", exited: false };
    this.login = state;
    this.authCache = null;
    const onData = (d: Buffer) => {
      state.output = (state.output + stripAnsi(d.toString())).slice(-20_000);
      if (!state.url) {
        const m = state.output.match(/https:\/\/[^\s"'<>]+oauth\/authorize\?[^\s"'<>]+/);
        if (m) state.url = m[0];
      }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    proc.on("error", () => (state.exited = true));
    proc.on("close", () => {
      state.exited = true;
      this.authCache = null;
    });
    const started = Date.now();
    while (!state.url && !state.exited && Date.now() - started < 20_000) await new Promise((r) => setTimeout(r, 200));
    if (!state.url) {
      killGroup(proc);
      throw new Error("Claude did not provide a sign-in link. " + truncate(state.output.trim(), 300));
    }
    return { state: "pending", flow: "code-paste", url: state.url };
  }

  async submitLoginCode(code: string): Promise<AuthState> {
    const st = this.login;
    if (!st || st.exited) throw new Error("No sign-in in progress. Start again.");
    const before = st.output.length;
    // The code goes to a terminal: allow only printable ASCII, no control characters.
    if (!/^[\x21-\x7e]{8,2048}$/.test(code)) throw new Error("That does not look like a sign-in code.");
    st.proc.stdin!.write(code + "\r");
    const started = Date.now();
    while (!st.exited && Date.now() - started < 30_000) {
      const tail = st.output.slice(before);
      if (/success|logged in|signed in/i.test(tail)) break;
      if (/invalid|error|failed|wasn't accepted/i.test(tail)) {
        killGroup(st.proc);
        this.login = null;
        throw new Error(truncate(tail.trim(), 300) || "Sign-in failed");
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    setTimeout(() => killGroup(st.proc), 2000).unref();
    this.login = null;
    this.authCache = null;
    const a = await this.auth();
    if (a.state !== "signed-in") throw new Error("Sign-in did not complete. " + truncate(st.output.slice(before).trim(), 300));
    return a;
  }

  async cancelLogin(): Promise<void> {
    if (this.login && !this.login.exited) killGroup(this.login.proc);
    this.login = null;
    this.authCache = null;
  }

  async logout(): Promise<void> {
    const bin = this.bin;
    if (!bin) return;
    await new Promise<void>((resolve) => {
      const p = spawn(bin, ["auth", "logout"], { env: agentEnv(), stdio: "ignore" });
      p.on("close", () => resolve());
      p.on("error", () => resolve());
    });
    this.authCache = null;
  }

  async run(ctx: TurnContext): Promise<{ status: "completed" | "interrupted" }> {
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    const mode = ctx.mode as PermissionMode;
    const { model, effort } = pickModel(await this.models(), ctx.model, ctx.effort);
    const st: StreamState = {
      toolParts: new Map(),
      streamed: new Set(), // assistant message ids we received stream events for
      blockPart: new Map(), // `${msgId}:${index}` -> part id
      current: "",
    };

    const canUseTool: CanUseTool = async (toolName, input, options) => {
      const id = options.toolUseID || randomUUID();
      // Claude asks the user a multiple-choice question: show it, return the answers.
      if (toolName === "AskUserQuestion") {
        const qs: any[] = Array.isArray((input as any)?.questions) ? (input as any).questions : [];
        const answers = await ctx.requestInput({
          partId: `${id}:q`,
          signal: options.signal,
          questions: qs.map((q) => ({
            id: String(q.question ?? ""),
            header: String(q.header ?? ""),
            question: String(q.question ?? ""),
            options: Array.isArray(q.options) ? q.options.map((o: any) => ({ label: String(o.label ?? ""), description: o.description })) : [],
            multiSelect: !!q.multiSelect,
            allowOther: true, // Claude always offers "Other"
          })),
        });
        if (!answers) return { behavior: "deny", message: "The user dismissed the question without answering.", toolUseID: id };
        return {
          behavior: "allow",
          updatedInput: { ...input, answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, v.join(", ")])) },
          toolUseID: id,
        };
      }
      const decision = await ctx.requestApproval({
        toolPartId: id,
        name: toolName,
        kind: kindOf(toolName),
        title: toolTitle(toolName, input),
        input,
        reason: options.decisionReason || (options as any).description,
        // Claude can withdraw the question (e.g. the turn moved on): close the card then.
        signal: options.signal,
      });
      if (decision === "deny") return { behavior: "deny", message: "The user declined this action.", toolUseID: id };
      // When Claude says a standing rule would grant more than this action, "Always" means once.
      const remember = decision === "allow-session" && !options.suppressAlwaysAllowRule;
      return {
        behavior: "allow",
        updatedInput: input,
        updatedPermissions: remember ? sessionOnly(options.suggestions) : undefined,
        toolUseID: id,
      };
    };

    // The input stays open for the whole turn: messages the user sends meanwhile go into it.
    const firstUuid = randomUUID();
    const outbox: SDKUserMessage[] = [userMessage(ctx.prompt, ctx.attachments, firstUuid)];
    let wake: (() => void) | null = null;
    let closed = false;
    const finish = () => {
      closed = true;
      wake?.();
    };
    async function* input(): AsyncIterable<SDKUserMessage> {
      while (!closed) {
        const next = outbox.shift();
        if (next) yield next;
        else await new Promise<void>((r) => (wake = r));
      }
    }
    /** Steered messages Claude Code has not reported as taken into a reply yet. */
    const pending = new Set<string>();
    /** Claude Code reports which user messages each reply answers (user_message_uuids). */
    let stamped = false;
    let ended = false;
    ctx.setSteer?.(async ({ text, attachments }) => {
      // Without the reports, a steered message could be dropped unnoticed when the turn ends:
      // then Twinmind queues it instead.
      if (ended || !stamped || ctx.signal.aborted) return false;
      const uuid = randomUUID();
      pending.add(uuid);
      outbox.push({ ...userMessage(text, attachments, uuid), priority: "next" });
      wake?.();
      return true;
    });

    // Claude refuses bypass mode as root unless told it is in a sandbox (the add-on container).
    const env = agentEnv(mode === "bypassPermissions" ? { IS_SANDBOX: "1" } : {});

    const q = query({
      prompt: input(),
      options: {
        cwd: ctx.cwd,
        resume: ctx.nativeId,
        model: model ?? undefined,
        effort: (effort ?? undefined) as EffortLevel | undefined,
        permissionMode: mode,
        thinking: THINKING,
        allowDangerouslySkipPermissions: mode === "bypassPermissions",
        includePartialMessages: true,
        canUseTool,
        // Twinmind's Home Assistant tools. Approval for changes is enforced by Twinmind's MCP gate,
        // so Claude itself does not prompt for them, except in Auto: there Claude Code's auto-mode
        // classifier reviews each HA change like any other action and allows or blocks it
        // (verified with Claude Code 2.1.332; models without auto mode ask instead).
        ...(ctx.mcp
          ? {
              mcpServers: { [HA_MCP_SERVER]: { type: "http" as const, url: ctx.mcp.url, headers: { Authorization: `Bearer ${ctx.mcp.secret}` } } },
              // Over stdin, not the command line: every command Claude runs could read the
              // bearer secret and this chat's MCP URL from /proc/<pid>/cmdline otherwise.
              mcpServersDelivery: "initialize" as const,
              ...(mode === "auto" ? {} : { allowedTools: [`mcp__${HA_MCP_SERVER}`] }),
            }
          : {}),
        abortController,
        env,
        pathToClaudeCodeExecutable: this.bin ?? undefined,
        // No settings files: an assistant that may edit /config without asking could otherwise
        // write itself permission rules or hooks in /config/.claude and use them next turn.
        settingSources: [],
        systemPrompt: { type: "preset", preset: "claude_code", append: HA_INSTRUCTIONS + projectContext(ctx.cwd) },
        stderr: (d) => process.env.TWINMIND_DEBUG && process.stderr.write(`[claude] ${d}`),
      },
    });

    let resultError: string | null = null;
    try {
      for await (const m of q as AsyncIterable<SDKMessage>) {
        if (ctx.signal.aborted) break;
        const taken: string[] = (m as any).user_message_uuids ?? ((m as any).user_message_uuid ? [(m as any).user_message_uuid] : []);
        for (const u of taken) {
          if (u === firstUuid) stamped = true;
          pending.delete(u);
        }
        this.handle(m, ctx, st);
        if (m.type === "result") {
          // Messages steered in too late for this reply get one of their own: keep reading.
          if (pending.size && !resultError && m.subtype === "success" && !m.is_error) continue;
          // The main model has the largest context window among the models used.
          const windows = Object.values((m as any).modelUsage ?? {}).map((x: any) => Number(x?.contextWindow) || 0);
          if (windows.length) st.contextWindow = Math.max(...windows);
          this.emitUsage(ctx, st);
          if (m.subtype !== "success" || m.is_error) {
            resultError = (m as any).result || (m as any).errors?.join("\n") || `Claude stopped: ${m.subtype}`;
          }
          break;
        }
      }
    } finally {
      ended = true;
      finish();
      ctx.signal.removeEventListener("abort", onAbort);
      try {
        q.close();
      } catch {
        /* already closed */
      }
    }
    if (ctx.signal.aborted) return { status: "interrupted" };
    if (resultError) throw new Error(resultError);
    return { status: "completed" };
  }

  private emitUsage(ctx: TurnContext, st: StreamState) {
    const u = st.usage;
    if (!u) return;
    ctx.emit({
      type: "usage",
      usage: {
        inputTokens: u.input + u.cacheRead + u.cacheWrite,
        cachedInputTokens: u.cacheRead,
        outputTokens: u.output,
        contextTokens: u.input + u.cacheRead + u.cacheWrite + u.output,
        contextWindow: st.contextWindow,
      },
    });
  }

  private handle(m: SDKMessage, ctx: TurnContext, st: StreamState) {
    const anyM = m as any;
    if (m.type === "system" && anyM.subtype === "init" && anyM.session_id) {
      ctx.emit({ type: "native-id", id: anyM.session_id });
      return;
    }
    if (anyM.parent_tool_use_id) return; // subagent internals are summarized by the Task tool card

    if (m.type === "stream_event") {
      const ev = anyM.event;
      if (ev.type === "message_start") {
        st.current = ev.message.id;
        st.streamed.add(ev.message.id);
        const u = ev.message?.usage;
        if (u) {
          st.usage = {
            input: u.input_tokens ?? 0,
            cacheRead: u.cache_read_input_tokens ?? 0,
            cacheWrite: u.cache_creation_input_tokens ?? 0,
            output: u.output_tokens ?? 0,
          };
        }
      } else if (ev.type === "message_delta" && st.usage && ev.usage?.output_tokens != null) {
        st.usage.output = ev.usage.output_tokens;
        this.emitUsage(ctx, st);
      } else if (ev.type === "content_block_start") {
        const kind = ev.content_block?.type;
        if (kind === "text" || kind === "thinking") {
          st.blockPart.set(`${st.current}:${ev.index}`, randomUUID());
        }
      } else if (ev.type === "content_block_delta") {
        const pid = st.blockPart.get(`${st.current}:${ev.index}`);
        if (!pid) return;
        if (ev.delta.type === "text_delta") ctx.emit({ type: "text-delta", partId: pid, delta: ev.delta.text });
        else if (ev.delta.type === "thinking_delta") ctx.emit({ type: "reasoning-delta", partId: pid, delta: ev.delta.thinking });
      }
      return;
    }

    if (m.type === "assistant") {
      const msg = anyM.message;
      const wasStreamed = st.streamed.has(msg.id);
      for (const block of msg.content ?? []) {
        if (block.type === "tool_use") {
          const existing = st.toolParts.get(block.id);
          const part: Extract<Part, { type: "tool" }> = {
            type: "tool",
            id: block.id,
            name: block.name,
            kind: kindOf(block.name),
            title: toolTitle(block.name, block.input),
            input: block.input,
            state: existing?.state === "awaiting-approval" ? "awaiting-approval" : "running",
            approval: existing?.approval,
          };
          st.toolParts.set(block.id, part);
          ctx.emit({ type: "part", part });
          if (block.name === "TodoWrite" && Array.isArray(block.input?.todos)) {
            ctx.emit({
              type: "part",
              part: {
                type: "todo",
                id: "todo",
                items: block.input.todos.map((t: any) => ({ text: String(t.content ?? t.activeForm ?? ""), status: t.status })),
              },
            });
          }
        } else if (!wasStreamed && block.type === "text" && block.text) {
          ctx.emit({ type: "part", part: { type: "text", id: randomUUID(), text: block.text } });
        } else if (!wasStreamed && block.type === "thinking" && block.thinking) {
          ctx.emit({ type: "part", part: { type: "reasoning", id: randomUUID(), text: block.thinking, done: true } });
        }
      }
      return;
    }

    if (m.type === "user") {
      const content = anyM.message?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const part = st.toolParts.get(block.tool_use_id);
        if (!part) continue;
        const output = truncate(stringifyOutput(block.content), 20_000);
        const denied = block.is_error && /declined|denied|rejected/i.test(output);
        const next = {
          ...part,
          output,
          state: denied ? ("denied" as const) : block.is_error ? ("error" as const) : ("completed" as const),
        };
        st.toolParts.set(part.id, next);
        ctx.emit({ type: "part", part: next });
      }
    }
  }

  async listNative(): Promise<NativeSession[]> {
    const sessions = await listSessions({ dir: this.opts.cwd, limit: 50 });
    return sessions.map((s) => ({
      id: s.sessionId,
      title: s.customTitle || s.summary || s.firstPrompt || "Claude session",
      updatedAt: s.lastModified,
      cwd: s.cwd,
    }));
  }

  async readNative(id: string): Promise<ChatMessage[]> {
    const raw = await getSessionMessages(id, { dir: this.opts.cwd });
    const out: ChatMessage[] = [];
    for (const m of raw) {
      if (m.parent_tool_use_id) continue;
      const msg = m.message as any;
      const content = typeof msg?.content === "string" ? [{ type: "text", text: msg.content }] : msg?.content ?? [];
      const texts = content.filter((b: any) => b.type === "text" && b.text?.trim()).map((b: any) => b.text);
      const tools = content.filter((b: any) => b.type === "tool_use");
      if (!texts.length && !tools.length) continue;
      const parts: Part[] = [
        ...texts.map((t: string) => ({ type: "text" as const, id: randomUUID(), text: t })),
        ...tools.map((b: any) => ({
          type: "tool" as const,
          id: b.id,
          name: b.name,
          kind: kindOf(b.name),
          title: toolTitle(b.name, b.input),
          input: b.input,
          state: "completed" as const,
        })),
      ];
      const role = m.type === "assistant" ? "assistant" : "user";
      const last = out[out.length - 1];
      if (last && last.role === role && role === "assistant") last.parts.push(...parts);
      else out.push({ id: m.uuid || randomUUID(), role, provider: "claude", parts, createdAt: Date.now(), status: "completed" });
    }
    return out;
  }
}
