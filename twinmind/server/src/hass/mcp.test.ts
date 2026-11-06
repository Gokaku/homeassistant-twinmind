import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeHa } from "../testing/fake-ha.js";
import { HassClient } from "./client.js";
import { startMcpEndpoint, type GateDecision, type McpEndpoint } from "./mcp.js";

const ha = createFakeHa();
let client: HassClient;
let endpoint: McpEndpoint;
const TOKEN = "conversation-token-123456";
let nextDecision: GateDecision = { ok: true };
/** When set, decide() waits for the request's abort signal instead of answering. */
let waitForAbort: ((aborted: boolean) => void) | null = null;
const asked: string[] = [];

beforeAll(async () => {
  client = new HassClient({ ...(await ha.listen()), token: ha.token, timeoutMs: 3000 });
  endpoint = await startMcpEndpoint({
    ha: client,
    gate: {
      session: (t) =>
        t === TOKEN
          ? {
              decide: async (tool, _args, summary, signal) => {
                asked.push(`${tool.name}: ${summary}`);
                if (waitForAbort) {
                  const report = waitForAbort;
                  await new Promise<void>((r) => signal?.addEventListener("abort", () => r(), { once: true }));
                  report(!!signal?.aborted);
                  return { ok: true };
                }
                return nextDecision;
              },
            }
          : null,
    },
  });
});
afterAll(async () => {
  await endpoint.close();
  client.close();
  ha.close();
});

async function connect(token = TOKEN, secret = endpoint.secret) {
  const c = new Client({ name: "test", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(endpoint.url(token)), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }));
  return c;
}

const text = (r: any) => r.content.map((c: any) => c.text).join("");

describe("Home Assistant MCP endpoint", () => {
  it("refuses a wrong secret and an unknown conversation", async () => {
    await expect(connect(TOKEN, "wrong")).rejects.toThrow();
    await expect(connect("unknown-token-xxxxxxxx")).rejects.toThrow();
  });

  it("lists the tools with read-only hints", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("ha_search_entities");
    expect(names).toContain("ha_update_entity");
    expect(tools.find((t) => t.name === "ha_get_logs")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "ha_call_service")?.annotations?.readOnlyHint).toBe(false);
    await c.close();
  });

  it("runs read-only tools without asking", async () => {
    const c = await connect();
    asked.length = 0;
    const r = await c.callTool({ name: "ha_search_entities", arguments: { query: "kitchen" } });
    const data = JSON.parse(text(r));
    expect(data.entities.map((e: any) => e.entity_id)).toEqual(["light.kitchen"]);
    expect(data.entities[0].area).toBe("Kitchen"); // from the device
    const logs = await c.callTool({ name: "ha_get_logs", arguments: { source: "core", filter: "ERROR", lines: 3 } });
    expect(text(logs).split("\n")).toHaveLength(3);
    const errors = JSON.parse(text(await c.callTool({ name: "ha_get_logs", arguments: {} })));
    expect(errors[0].message).toBe("Bridge unreachable");
    expect(asked).toEqual([]);
    await c.close();
  });

  it("asks before changing anything, and respects a denial", async () => {
    const c = await connect();
    asked.length = 0;
    nextDecision = { ok: false, reason: "The user declined." };
    const r: any = await c.callTool({ name: "ha_update_entity", arguments: { entity_id: "light.kitchen", name: "Island" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("declined");
    expect(asked).toEqual(["ha_update_entity: light.kitchen name “Island”"]);
    expect(ha.state.entities.find((e) => e.entity_id === "light.kitchen").name).toBeNull();
    await c.close();
  });

  it("renames entities and calls services once allowed", async () => {
    const c = await connect();
    nextDecision = { ok: true };
    await c.callTool({ name: "ha_update_entity", arguments: { entity_id: "light.hallway", new_entity_id: "light.corridor", name: "Corridor" } });
    expect(ha.state.entities.find((e) => e.entity_id === "light.corridor")?.name).toBe("Corridor");
    await c.callTool({ name: "ha_call_service", arguments: { domain: "light", service: "turn_on", target: { entity_id: "light.kitchen" }, data: { brightness_pct: 40 } } });
    expect(ha.state.serviceCalls.at(-1)).toEqual({ domain: "light", service: "turn_on", data: { brightness_pct: 40, entity_id: "light.kitchen" } });
    await c.close();
  });

  it("saves and reads automations through the config API", async () => {
    const c = await connect();
    nextDecision = { ok: true };
    const saved = JSON.parse(text(await c.callTool({ name: "ha_save_automation", arguments: { config: { alias: "Hall at sunset", triggers: [{ trigger: "sun", event: "sunset" }], actions: [] } } })));
    expect(ha.state.automations[saved.id].alias).toBe("Hall at sunset");
    const got = JSON.parse(text(await c.callTool({ name: "ha_get_automation", arguments: { entity_id: "automation.night" } })));
    expect(got.config.alias).toBe("Night mode");
    await c.close();
  });

  it("cancels a pending approval when the client disconnects, and does not run the change", async () => {
    const aborted = new Promise<boolean>((r) => (waitForAbort = r));
    const before = ha.state.serviceCalls.length;
    const ac = new AbortController();
    const call = fetch(endpoint.url(TOKEN), {
      method: "POST",
      signal: ac.signal,
      headers: { Authorization: `Bearer ${endpoint.secret}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ha_call_service", arguments: { domain: "light", service: "turn_off", target: { entity_id: "light.kitchen" } } },
      }),
    }).catch(() => "aborted");
    setTimeout(() => ac.abort(), 300);
    expect(await call).toBe("aborted");
    try {
      expect(await Promise.race([aborted, new Promise((r) => setTimeout(() => r("no abort seen"), 2000))])).toBe(true);
    } finally {
      waitForAbort = null;
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(ha.state.serviceCalls.length).toBe(before);
  });

  it("rejects invalid service names", async () => {
    const c = await connect();
    const r: any = await c.callTool({ name: "ha_call_service", arguments: { domain: "light/../x", service: "on" } });
    expect(r.isError).toBe(true);
    await c.close();
  });
});
