import express, { type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { ChatService } from "./chat.js";
import type { AppConfig } from "./config.js";
import { AdminGuard, isLoopback, type Principal } from "./guard.js";
import type { ClientMessage, ProviderId, ProviderInfo, ServerEvent } from "./protocol.js";
import type { Provider } from "./providers/types.js";
import { isValidId, type ConversationStore } from "./store.js";
import type { UploadStore } from "./uploads.js";

export interface AppDeps {
  config: AppConfig;
  guard: AdminGuard;
  store: ConversationStore;
  uploads: UploadStore;
  providers: Provider[];
}

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  // Ingress shows the app in an iframe on the same origin as Home Assistant.
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss: blob: data:; media-src 'self' blob:; frame-ancestors 'self'; base-uri 'self'; form-action 'none'",
};

export function createApp(deps: AppDeps) {
  const { config, guard, store, uploads } = deps;
  const providers = new Map<ProviderId, Provider>(deps.providers.map((p) => [p.id, p]));
  const sockets = new Set<WebSocket>();
  const broadcast = (e: ServerEvent) => {
    const data = JSON.stringify(e);
    for (const s of sockets) if (s.readyState === s.OPEN) s.send(data);
  };
  const chat = new ChatService(store, uploads, providers, config.workDir, broadcast);

  async function providerInfo(): Promise<ProviderInfo[]> {
    return Promise.all(
      [...providers.values()].map(async (p) => {
        const [auth, models] = await Promise.all([
          p.auth().catch((e) => ({ state: "unavailable" as const, reason: String(e?.message ?? e) })),
          p.models().catch(() => []),
        ]);
        return { id: p.id, label: p.label, modes: p.modes, defaultMode: p.defaultMode, models, auth };
      }),
    );
  }
  const pushProviders = async () => broadcast({ type: "providers", providers: await providerInfo() });

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use((_req, res, next) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    next();
  });

  // Health check: loopback only, no user needed.
  app.get("/healthz", (req, res) => {
    if (!isLoopback(req.socket.remoteAddress)) return res.status(403).end();
    res.json({ ok: true });
  });

  // Everything else: ingress + Home Assistant admin.
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    const r = await guard.check(req);
    if (!r.ok) {
      res.status(r.status);
      if (req.path.startsWith("/api/")) return res.json({ error: r.reason });
      return res.type("html").send(deniedPage(r.reason));
    }
    res.locals.user = r.user;
    next();
  });

  // CSRF: mutating requests must carry a custom header. Browsers only let
  // same-origin scripts set it (we never answer CORS preflights).
  app.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    if (req.header("x-twinmind") !== "1") return res.status(403).json({ error: "Missing request header" });
    next();
  });

  const api = express.Router();
  // Uploads take the raw body, so they must be registered before the JSON parser
  // (which would otherwise consume application/json files).
  api.post(
    "/uploads",
    express.raw({ type: () => true, limit: config.maxUploadBytes }),
    async (req, res) => {
      const name = decodeURIComponent(String(req.header("x-file-name") ?? "file"));
      const type = String(req.header("content-type") ?? "application/octet-stream");
      if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: "No file" });
      try {
        const u = await uploads.save(name, type, req.body);
        res.json({ upload: { id: u.id, name: u.name, mediaType: u.mediaType, size: u.size } });
      } catch (e: any) {
        res.status(400).json({ error: e?.message ?? "Upload failed" });
      }
    },
  );
  api.use(express.json({ limit: "1mb" }));

  api.get("/me", (_req, res) => res.json({ user: res.locals.user as Principal }));
  api.get("/providers", async (_req, res) => res.json({ providers: await providerInfo() }));

  api.get("/conversations", (_req, res) =>
    res.json({ conversations: store.list().map((m) => ({ ...m, running: chat.isRunning(m.id) })) }),
  );
  api.get("/conversations/:id", (req, res) => {
    const c = store.get(req.params.id);
    if (!c) return res.status(404).json({ error: "Not found" });
    res.json({ conversation: { ...c, running: chat.isRunning(c.id) } });
  });
  api.patch("/conversations/:id", async (req, res) => {
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    if (!title) return res.status(400).json({ error: "Title required" });
    const c = await store.rename(req.params.id, title);
    if (!c) return res.status(404).json({ error: "Not found" });
    broadcast({ type: "conversation", meta: chat.metaWithStatus(c) });
    res.json({ ok: true });
  });
  api.delete("/conversations/:id", async (req, res) => {
    if (chat.isRunning(req.params.id)) chat.interrupt(req.params.id);
    if (!(await store.delete(req.params.id))) return res.status(404).json({ error: "Not found" });
    chat.forget(req.params.id);
    broadcast({ type: "conversation.deleted", id: req.params.id });
    res.json({ ok: true });
  });

  // Native sessions (created by this add-on or elsewhere) that can be imported.
  api.get("/providers/:id/sessions", async (req, res) => {
    const p = providers.get(req.params.id as ProviderId);
    if (!p?.listNative) return res.json({ sessions: [] });
    try {
      const linked = new Set(store.list().map((m) => m.native[p.id]).filter(Boolean));
      const sessions = (await p.listNative()).filter((s) => !linked.has(s.id));
      res.json({ sessions });
    } catch (e: any) {
      res.status(502).json({ error: e?.message ?? "Failed to list sessions" });
    }
  });
  api.post("/providers/:id/sessions/:sid/import", async (req, res) => {
    const p = providers.get(req.params.id as ProviderId);
    const sid = String(req.params.sid);
    if (!p?.listNative || !p.readNative || !/^[\w.-]{1,128}$/.test(sid)) return res.status(404).json({ error: "Not found" });
    try {
      const sessions = await p.listNative();
      const s = sessions.find((x) => x.id === sid);
      if (!s) return res.status(404).json({ error: "Session not found" });
      const messages = await p.readNative(sid);
      const c = store.create(p.id, s.title.slice(0, 60) || "Imported chat");
      c.native[p.id] = sid;
      c.messages = messages;
      c.seen[p.id] = messages.length;
      c.updatedAt = s.updatedAt || Date.now();
      await store.save(c);
      broadcast({ type: "conversation", meta: chat.metaWithStatus(c) });
      res.json({ id: c.id });
    } catch (e: any) {
      res.status(502).json({ error: e?.message ?? "Import failed" });
    }
  });

  // Sign-in flows.
  api.post("/providers/:id/login", async (req, res) => {
    const p = providers.get(req.params.id as ProviderId);
    if (!p?.startLogin) return res.status(404).json({ error: "Not supported" });
    try {
      const auth = await p.startLogin();
      res.json({ auth });
      void pushProviders();
      watchLogin(p, pushProviders);
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "Login failed" });
    }
  });
  api.post("/providers/:id/login/code", async (req, res) => {
    const p = providers.get(req.params.id as ProviderId);
    const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
    if (!p?.submitLoginCode || !code || code.length > 4096) return res.status(400).json({ error: "Code required" });
    try {
      res.json({ auth: await p.submitLoginCode(code) });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Code rejected" });
    } finally {
      void pushProviders();
    }
  });
  api.post("/providers/:id/login/cancel", async (req, res) => {
    const p = providers.get(req.params.id as ProviderId);
    await p?.cancelLogin?.().catch(() => {});
    res.json({ ok: true });
    void pushProviders();
  });
  api.post("/providers/:id/logout", async (req, res) => {
    const p = providers.get(req.params.id as ProviderId);
    if (!p?.logout) return res.status(404).json({ error: "Not supported" });
    try {
      await p.logout();
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "Logout failed" });
    } finally {
      void pushProviders();
    }
  });

  api.get("/uploads/:id", async (req, res) => {
    const u = await uploads.get(req.params.id);
    if (!u) return res.status(404).end();
    const inline = u.mediaType.startsWith("image/");
    res.setHeader("Content-Type", inline ? u.mediaType : "application/octet-stream");
    res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(u.name)}`);
    fs.createReadStream(u.path).pipe(res);
  });

  api.use((_req, res) => res.status(404).json({ error: "Not found" }));
  api.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err?.status === 413 ? 413 : err?.status === 400 ? 400 : 500;
    res.status(status).json({ error: status === 413 ? "Too large" : err?.message ?? "Server error" });
  });
  app.use("/api", api);

  // The single-page web app.
  if (fs.existsSync(config.webDir)) {
    app.use(express.static(config.webDir, { index: false, maxAge: "1h" }));
    app.get(/.*/, (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.sendFile(path.join(config.webDir, "index.html"));
    });
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on("upgrade", async (req, socket, head) => {
    const reject = (code: number, msg: string) => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/api/ws") return reject(404, "Not Found");
    const r = await guard.check(req);
    if (!r.ok) return reject(r.status, "Forbidden");
    if (!sameOrigin(req)) {
      console.warn(`[twinmind] rejected WebSocket from origin ${req.headers.origin} (host ${req.headers["x-forwarded-host"] ?? req.headers.host})`);
      return reject(403, "Forbidden");
    }
    wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, r.user, req));
  });

  function onSocket(ws: WebSocket, user: Principal, req: http.IncomingMessage) {
    sockets.add(ws);
    let alive = true;
    ws.on("pong", () => (alive = true));
    const heartbeat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 30_000);
    const send = (e: ServerEvent) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(e));

    void providerInfo().then((providers) => send({ type: "hello", user: { id: user.id, name: user.name }, providers }));

    ws.on("message", async (raw) => {
      // Re-check on every message: admin rights can be revoked while a socket is open.
      const g = await guard.check(req);
      if (!g.ok) {
        send({ type: "error", message: g.reason });
        return ws.close(4403, "Forbidden");
      }
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send({ type: "error", message: "Invalid message" });
      }
      try {
        switch (msg.type) {
          case "ping":
            return send({ type: "pong" });
          case "send":
            return await chat.send(msg);
          case "approve":
            if (typeof msg.approvalId !== "string" || !chat.approve(msg.approvalId, msg.decision))
              send({ type: "error", message: "That approval is no longer pending" });
            return;
          case "interrupt":
            if (isValidId(msg.conversationId)) chat.interrupt(msg.conversationId);
            return;
          case "subscribe": {
            // Sent on the event socket so the snapshot is ordered with the live events:
            // everything after it is newer, nothing is lost or applied twice.
            const c = isValidId(msg.conversationId) ? store.get(msg.conversationId) : undefined;
            if (!c) return send({ type: "error", message: "Conversation not found" });
            return send({ type: "snapshot", conversation: { ...c, running: chat.isRunning(c.id) } });
          }
          default:
            return;
        }
      } catch (e: any) {
        send({ type: "error", message: e?.message ?? "Request failed", clientRequestId: (msg as any).clientRequestId });
      }
    });
    ws.on("close", () => {
      clearInterval(heartbeat);
      sockets.delete(ws);
    });
  }

  return { app, server, chat, wss, shutdown: () => chat.interruptAll() };
}

/** Poll provider auth after a login starts, so the UI updates when it completes. */
function watchLogin(p: Provider, onChange: () => Promise<void>) {
  let n = 0;
  const t = setInterval(async () => {
    n++;
    const a = await p.auth().catch(() => null);
    if (!a || a.state !== "pending" || n > 300) {
      clearInterval(t);
      await onChange();
    }
  }, 2000);
  t.unref();
}

function sameOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client already passed the ingress + admin gate
  const hosts = [req.headers["x-forwarded-host"], req.headers.host]
    .flat()
    .filter(Boolean)
    .flatMap((h) => String(h).split(","))
    .map((h) => h.trim().toLowerCase());
  try {
    return hosts.includes(new URL(origin).host.toLowerCase());
  } catch {
    return false;
  }
}

function deniedPage(reason: string): string {
  const esc = reason.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Twinmind</title><body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#0b0b10;color:#e8e8ef"><div style="max-width:28rem;padding:1.5rem;text-align:center"><h1 style="font-size:1.25rem">Twinmind is admin-only</h1><p style="opacity:.75">${esc}</p></div>`;
}
