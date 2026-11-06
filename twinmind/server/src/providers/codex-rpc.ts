import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline";

const require = createRequire(import.meta.url);

/** Locate the native `codex` binary shipped in the @openai/codex npm package. */
export function findCodexBinary(): string | null {
  if (process.env.TWINMIND_CODEX_BIN) return process.env.TWINMIND_CODEX_BIN;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const triple = arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl";
  for (const pkg of [`@openai/codex-linux-${arch}`, "@openai/codex"]) {
    try {
      const root = path.dirname(require.resolve(`${pkg}/package.json`));
      const bin = path.join(root, "vendor", triple, "bin", "codex");
      if (fs.existsSync(bin)) return bin;
    } catch {
      /* not installed */
    }
  }
  return null;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export interface ServerRequestMsg {
  id: number | string;
  method: string;
  params: any;
}

/**
 * Minimal JSON-RPC client for `codex app-server` (newline-delimited JSON over stdio).
 * Emits "notification" (method, params) and "request" (ServerRequestMsg) events.
 * Server requests must be answered with respond()/respondError().
 */
export class CodexRpc extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private ready: Promise<void> | null = null;
  private stderrTail = "";

  constructor(
    private readonly bin: string,
    /** Evaluated when the app-server starts. */
    private readonly env: () => NodeJS.ProcessEnv,
  ) {
    super();
  }

  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const proc = spawn(this.bin, ["app-server"], { env: this.env(), stdio: ["pipe", "pipe", "pipe"] });
      this.proc = proc;
      proc.stderr.on("data", (d) => {
        this.stderrTail = (this.stderrTail + d.toString()).slice(-4000);
        if (process.env.TWINMIND_DEBUG) process.stderr.write(`[codex] ${d}`);
      });
      proc.on("exit", (code) => {
        const err = new Error(`Codex app-server exited (${code}). ${this.stderrTail.trim().split("\n").pop() ?? ""}`);
        for (const p of this.pending.values()) clearTimeout(p.timer), p.reject(err);
        this.pending.clear();
        this.proc = null;
        this.ready = null;
        this.emit("exit", err);
      });
      proc.on("error", (e) => this.emit("error", e));
      const rl = readline.createInterface({ input: proc.stdout });
      rl.on("line", (line) => this.onLine(line));
      await this.request("initialize", {
        clientInfo: { name: "twinmind", title: "Twinmind", version: "0.1.0" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      this.notify("initialized");
    })();
    this.ready.catch(() => (this.ready = null));
    return this.ready;
  }

  private onLine(line: string) {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method) {
      this.emit("request", { id: msg.id, method: msg.method, params: msg.params } satisfies ServerRequestMsg);
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? "Codex request failed"));
      else p.resolve(msg.result);
    } else if (msg.method) {
      this.emit("notification", msg.method, msg.params);
    }
  }

  private write(obj: unknown) {
    if (!this.proc) throw new Error("Codex app-server is not running");
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  async call<T = any>(method: string, params: unknown = {}, timeoutMs = 60_000): Promise<T> {
    await this.start();
    return this.request<T>(method, params, timeoutMs);
  }

  private request<T>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex did not answer ${method} in time`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  notify(method: string, params?: unknown) {
    this.write(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  respond(id: number | string, result: unknown) {
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id: number | string, message: string) {
    this.write({ jsonrpc: "2.0", id, error: { code: -32601, message } });
  }

  async stop(): Promise<void> {
    this.proc?.kill();
    this.proc = null;
    this.ready = null;
  }
}
