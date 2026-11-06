import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { coreUserLister } from "./ha.js";

let wss: WebSocketServer | null = null;
afterEach(() => wss?.close());

function fakeCore(behaviour: "ok" | "bad-token" | "silent"): Promise<string> {
  return new Promise((resolve) => {
    wss = new WebSocketServer({ port: 0, host: "127.0.0.1" }, () =>
      resolve(`ws://127.0.0.1:${(wss!.address() as AddressInfo).port}`),
    );
    wss.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "auth_required" }));
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (behaviour === "silent") return;
        if (m.type === "auth") {
          ws.send(JSON.stringify({ type: m.access_token === "good" && behaviour === "ok" ? "auth_ok" : "auth_invalid" }));
        } else if (m.type === "config/auth/list") {
          ws.send(
            JSON.stringify({
              id: m.id,
              type: "result",
              success: true,
              result: [{ id: "u1", name: "A", is_owner: true, is_active: true, system_generated: false, group_ids: [] }],
            }),
          );
        }
      });
    });
  });
}

describe("coreUserLister", () => {
  it("authenticates and lists users", async () => {
    const url = await fakeCore("ok");
    const users = await coreUserLister(url, "good")();
    expect(users.map((u) => u.id)).toEqual(["u1"]);
  });

  it("rejects when the token is refused", async () => {
    const url = await fakeCore("bad-token");
    await expect(coreUserLister(url, "bad")()).rejects.toThrow(/rejected/);
  });

  it("times out when Home Assistant does not answer", async () => {
    const url = await fakeCore("silent");
    await expect(coreUserLister(url, "good", 200)()).rejects.toThrow(/timed out/);
  });

  it("rejects when nothing is listening", async () => {
    await expect(coreUserLister("ws://127.0.0.1:1", "good", 2000)()).rejects.toThrow();
  });
});
