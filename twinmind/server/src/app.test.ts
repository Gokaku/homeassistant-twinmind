import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { AdminGuard } from "./guard.js";
import type { HaUser } from "./ha.js";
import type { ServerEvent } from "./protocol.js";
import { HassClient } from "./hass/client.js";
import { startMcpEndpoint } from "./hass/mcp.js";
import { MockProvider } from "./providers/mock.js";
import { createFakeHa } from "./testing/fake-ha.js";
import { ConversationStore } from "./store.js";
import { UploadStore } from "./uploads.js";

const users: HaUser[] = [
  { id: "admin", name: "Adam", is_owner: false, is_active: true, system_generated: false, group_ids: ["system-admin"] },
  { id: "user", name: "Uma", is_owner: false, is_active: true, system_generated: false, group_ids: ["system-users"] },
];

let base = "";
let wsBase = "";
let dir = "";
let close: () => void;
const fakeHa = createFakeHa();

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "twinmind-test-"));
  const config = { ...loadConfig({ TWINMIND_DATA_DIR: dir, TWINMIND_WORKDIR: dir }), webDir: path.join(dir, "noweb") };
  // In tests the "ingress proxy" is loopback.
  const guard = new AdminGuard({ allowedAddresses: ["127.0.0.1", "::1"], listUsers: async () => users, cacheMs: 60_000 });
  const store = new ConversationStore(dir);
  const uploads = new UploadStore(dir, 1024 * 1024);
  await store.init();
  await uploads.init();
  const { server, chat } = createApp({ config, guard, store, uploads, providers: [new MockProvider(1)] });
  const hass = new HassClient({ ...(await fakeHa.listen()), token: fakeHa.token, timeoutMs: 3000 });
  const mcp = await startMcpEndpoint({ ha: hass, gate: chat });
  chat.attachMcp(mcp);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
  close = () => {
    server.close();
    void mcp.close();
    hass.close();
    fakeHa.close();
  };
});

afterAll(async () => {
  close?.();
  await fs.rm(dir, { recursive: true, force: true });
});

const admin = { "x-remote-user-id": "admin" };

describe("HTTP gate", () => {
  it("refuses requests without a user", async () => {
    expect((await fetch(`${base}/api/me`)).status).toBe(401);
  });
  it("refuses non-admin users", async () => {
    expect((await fetch(`${base}/api/me`, { headers: { "x-remote-user-id": "user" } })).status).toBe(403);
  });
  it("serves admins", async () => {
    const r = await fetch(`${base}/api/me`, { headers: admin });
    expect(r.status).toBe(200);
    expect((await r.json()).user.id).toBe("admin");
  });
  it("requires the CSRF header on mutations", async () => {
    const r = await fetch(`${base}/api/conversations/x`, { method: "DELETE", headers: admin });
    expect(r.status).toBe(403);
  });
  it("accepts JSON files as uploads (not parsed as a request body)", async () => {
    const r = await fetch(`${base}/api/uploads`, {
      method: "POST",
      headers: { ...admin, "x-twinmind": "1", "content-type": "application/json", "x-file-name": "states.json" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(r.status).toBe(200);
    const { upload } = await r.json();
    expect(upload.mediaType).toBe("application/json");
    expect(await (await fetch(`${base}/api/uploads/${upload.id}`, { headers: admin })).text()).toBe('{"a":1}');
  });

  it("accepts uploads and serves them back", async () => {
    const r = await fetch(`${base}/api/uploads`, {
      method: "POST",
      headers: { ...admin, "x-twinmind": "1", "content-type": "text/plain", "x-file-name": encodeURIComponent("../../evil name.txt") },
      body: "hello",
    });
    expect(r.status).toBe(200);
    const { upload } = await r.json();
    expect(upload.name).toBe("evil name.txt");
    const g = await fetch(`${base}/api/uploads/${upload.id}`, { headers: admin });
    expect(await g.text()).toBe("hello");
  });
});

function connect(headers: Record<string, string>) {
  const ws = new WebSocket(`${wsBase}/api/ws`, { headers });
  const events: ServerEvent[] = [];
  const waiters: { pred: (e: ServerEvent) => boolean; resolve: (e: ServerEvent) => void }[] = [];
  ws.on("message", (raw) => {
    const e = JSON.parse(raw.toString()) as ServerEvent;
    events.push(e);
    for (const w of [...waiters]) if (w.pred(e)) waiters.splice(waiters.indexOf(w), 1), w.resolve(e);
  });
  const waitFor = <T extends ServerEvent["type"]>(type: T, pred: (e: Extract<ServerEvent, { type: T }>) => boolean = () => true) =>
    new Promise<Extract<ServerEvent, { type: T }>>((resolve, reject) => {
      const found = events.find((e) => e.type === type && pred(e as any));
      if (found) return resolve(found as any);
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 5000);
      waiters.push({ pred: (e) => e.type === type && pred(e as any), resolve: (e) => (clearTimeout(t), resolve(e as any)) });
    });
  return { ws, events, waitFor };
}

describe("WebSocket", () => {
  it("rejects the upgrade for non-admins", async () => {
    const ws = new WebSocket(`${wsBase}/api/ws`, { headers: { "x-remote-user-id": "user" } });
    const status = await new Promise<number>((resolve) => ws.on("unexpected-response", (_req, res) => resolve(res.statusCode!)));
    expect(status).toBe(403);
  });

  it("rejects cross-origin upgrades", async () => {
    const ws = new WebSocket(`${wsBase}/api/ws`, { headers: { ...admin, origin: "https://evil.example" } });
    const status = await new Promise<number>((resolve) => ws.on("unexpected-response", (_req, res) => resolve(res.statusCode!)));
    expect(status).toBe(403);
  });

  it("runs a turn with an approval round-trip", async () => {
    const c = connect(admin);
    await c.waitFor("hello");
    c.ws.send(JSON.stringify({ type: "send", clientRequestId: "r1", provider: "mock", mode: "ask", text: "Hi there" }));
    const conv = await c.waitFor("conversation", (e) => e.clientRequestId === "r1");
    const part = await c.waitFor("part", (e) => e.part.type === "tool" && e.part.state === "awaiting-approval");
    const approvalId = (part.part as any).approval.id;
    c.ws.send(JSON.stringify({ type: "approve", approvalId, decision: "allow" }));
    const end = await c.waitFor("turn.end", (e) => e.conversationId === conv.meta.id);
    expect(end.status).toBe("completed");

    const r = await fetch(`${base}/api/conversations/${conv.meta.id}`, { headers: admin });
    const { conversation } = await r.json();
    expect(conversation.messages).toHaveLength(2);
    const reply = conversation.messages[1];
    expect(reply.parts.find((p: any) => p.type === "tool").state).toBe("completed");
    expect(reply.parts.find((p: any) => p.type === "text").text).toContain("Hi there");
    expect(conversation.native.mock).toBeTruthy();
    expect(conversation.seen.mock).toBe(2);
    c.ws.close();
  });

  it("can interrupt a turn waiting for approval", async () => {
    const c = connect(admin);
    await c.waitFor("hello");
    c.ws.send(JSON.stringify({ type: "send", clientRequestId: "r2", provider: "mock", mode: "ask", text: "Stop me" }));
    const conv = await c.waitFor("conversation", (e) => e.clientRequestId === "r2");
    await c.waitFor("part", (e) => e.part.type === "tool" && e.part.state === "awaiting-approval");
    c.ws.send(JSON.stringify({ type: "interrupt", conversationId: conv.meta.id }));
    const end = await c.waitFor("turn.end", (e) => e.conversationId === conv.meta.id);
    expect(end.status).toBe("interrupted");
    c.ws.close();
  });

  it("puts Home Assistant changes behind the approval card", async () => {
    const c = connect(admin);
    await c.waitFor("hello");
    c.ws.send(JSON.stringify({ type: "send", clientRequestId: "ha1", provider: "mock", mode: "ask", text: "rename the kitchen light" }));
    const conv = await c.waitFor("conversation", (e) => e.clientRequestId === "ha1");
    const part = await c.waitFor("part", (e) => e.part.type === "tool" && e.part.state === "awaiting-approval");
    // The approval landed on the assistant's own tool card.
    expect((part.part as any).name).toBe("mcp__homeassistant__ha_update_entity");
    expect(fakeHa.state.entities.find((e) => e.entity_id === "light.kitchen").name).toBeNull();
    c.ws.send(JSON.stringify({ type: "approve", approvalId: (part.part as any).approval.id, decision: "allow" }));
    await c.waitFor("turn.end", (e) => e.conversationId === conv.meta.id);
    expect(fakeHa.state.entities.find((e) => e.entity_id === "light.kitchen").name).toBe("Kitchen island");
    c.ws.close();
  });

  it("reports a denied Home Assistant change back to the assistant", async () => {
    fakeHa.state.entities.find((e) => e.entity_id === "light.kitchen").name = null;
    const c = connect(admin);
    await c.waitFor("hello");
    c.ws.send(JSON.stringify({ type: "send", clientRequestId: "ha2", provider: "mock", mode: "ask", text: "rename it" }));
    const conv = await c.waitFor("conversation", (e) => e.clientRequestId === "ha2");
    const part = await c.waitFor("part", (e) => e.conversationId === conv.meta.id && e.part.type === "tool" && e.part.state === "awaiting-approval");
    c.ws.send(JSON.stringify({ type: "approve", approvalId: (part.part as any).approval.id, decision: "deny" }));
    await c.waitFor("turn.end", (e) => e.conversationId === conv.meta.id);
    expect(fakeHa.state.entities.find((e) => e.entity_id === "light.kitchen").name).toBeNull();
    const r = await (await fetch(`${base}/api/conversations/${conv.meta.id}`, { headers: admin })).json();
    expect(JSON.stringify(r.conversation.messages[1].parts)).toContain("declined");
    c.ws.close();
  });

  it("answers subscribe with a snapshot on the event socket", async () => {
    const c = connect(admin);
    await c.waitFor("hello");
    c.ws.send(JSON.stringify({ type: "send", clientRequestId: "s1", provider: "mock", mode: "auto", text: "snapshot me" }));
    const conv = await c.waitFor("conversation", (e) => e.clientRequestId === "s1");
    await c.waitFor("turn.end", (e) => e.conversationId === conv.meta.id);
    c.ws.send(JSON.stringify({ type: "subscribe", conversationId: conv.meta.id }));
    const snap = await c.waitFor("snapshot", (e) => e.conversation.id === conv.meta.id);
    expect(snap.conversation.messages).toHaveLength(2);
    expect(snap.conversation.messages[1].status).toBe("completed");
    c.ws.close();
  });

  it("survives a WebSocket frame over the size limit", async () => {
    const c = connect(admin);
    await c.waitFor("hello");
    const closed = new Promise((r) => c.ws.on("close", r));
    c.ws.send("x".repeat(1024 * 1024 + 10));
    await closed;
    // The server is still up.
    expect((await fetch(`${base}/api/me`, { headers: admin })).status).toBe(200);
  });

  it("rejects unknown modes", async () => {
    const c = connect(admin);
    await c.waitFor("hello");
    c.ws.send(JSON.stringify({ type: "send", clientRequestId: "r3", provider: "mock", mode: "yolo", text: "x" }));
    const err = await c.waitFor("error", (e) => e.clientRequestId === "r3");
    expect(err.message).toMatch(/Unknown mode/);
    c.ws.close();
  });
});
