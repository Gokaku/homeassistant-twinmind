import WebSocket from "ws";

export interface HassClientOptions {
  /** ws://supervisor/core/websocket */
  wsUrl: string;
  /** http://supervisor/core/api */
  restUrl: string;
  /** http://supervisor */
  supervisorUrl: string;
  token: string;
  timeoutMs?: number;
}

export class HassError extends Error {
  constructor(
    message: string,
    readonly code?: string | number,
  ) {
    super(message);
  }
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/**
 * Talks to Home Assistant on behalf of the assistants, with the add-on's
 * Supervisor token: Core WebSocket API (registries, logs, config), Core REST
 * API, and the Supervisor API (logs).
 */
export class HassClient {
  private ws: WebSocket | null = null;
  private ready: Promise<WebSocket> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private readonly timeoutMs: number;

  constructor(private readonly opts: HassClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private connect(): Promise<WebSocket> {
    if (this.ready) return this.ready;
    this.ready = new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(this.opts.wsUrl, { maxPayload: 64 * 1024 * 1024 });
      const fail = (err: Error) => {
        this.ready = null;
        this.ws = null;
        for (const p of this.pending.values()) clearTimeout(p.timer), p.reject(err);
        this.pending.clear();
        reject(err);
      };
      const timer = setTimeout(() => (ws.terminate(), fail(new HassError("Home Assistant did not answer"))), 10_000);
      ws.on("error", (e) => fail(e instanceof Error ? e : new Error(String(e))));
      ws.on("close", () => fail(new HassError("Connection to Home Assistant closed")));
      ws.on("message", (raw) => {
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type === "auth_required") {
          ws.send(JSON.stringify({ type: "auth", access_token: this.opts.token }));
        } else if (msg.type === "auth_ok") {
          clearTimeout(timer);
          this.ws = ws;
          resolve(ws);
        } else if (msg.type === "auth_invalid") {
          clearTimeout(timer);
          ws.close();
          fail(new HassError("Home Assistant rejected the Supervisor token"));
        } else if (msg.type === "result" && typeof msg.id === "number") {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.success) p.resolve(msg.result);
          else p.reject(new HassError(msg.error?.message ?? "Home Assistant command failed", msg.error?.code));
        }
      });
    });
    this.ready.catch(() => {});
    return this.ready;
  }

  /** Send a Core WebSocket command and return its result. */
  async command<T = any>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    const ws = await this.connect();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HassError(`Home Assistant did not answer ${type} in time`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ ...payload, id, type }));
    });
  }

  private async http(base: string, method: string, path: string, body?: unknown, accept = "application/json"): Promise<any> {
    if (!path.startsWith("/") || path.includes("..")) throw new HassError("Invalid API path");
    const res = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        Accept: accept,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let data: any = text;
    if ((res.headers.get("content-type") ?? "").includes("json")) {
      try {
        data = JSON.parse(text);
      } catch {
        /* keep text */
      }
    }
    if (!res.ok) {
      const msg = typeof data === "object" ? (data?.message ?? data?.error ?? JSON.stringify(data)) : String(data).slice(0, 500);
      throw new HassError(`HTTP ${res.status}: ${msg}`, res.status);
    }
    // Supervisor wraps JSON answers as { result: "ok", data }.
    if (base === this.opts.supervisorUrl && data && typeof data === "object" && "data" in data && data.result === "ok") return data.data;
    return data;
  }

  /** Core REST API, path relative to /api (e.g. "/states"). */
  rest(method: string, path: string, body?: unknown): Promise<any> {
    return this.http(this.opts.restUrl, method, path, body);
  }

  /** Supervisor API, e.g. "/core/logs". */
  supervisor(method: string, path: string, body?: unknown, accept = "application/json"): Promise<any> {
    return this.http(this.opts.supervisorUrl, method, path, body, accept);
  }

  close() {
    this.ws?.close();
    this.ws = null;
    this.ready = null;
  }
}
