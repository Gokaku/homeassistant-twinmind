import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeHa } from "../testing/fake-ha.js";
import { HassClient } from "./client.js";

const ha = createFakeHa();
let client: HassClient;
let urls: Awaited<ReturnType<typeof ha.listen>>;

beforeAll(async () => {
  urls = await ha.listen();
  client = new HassClient({ ...urls, token: ha.token, timeoutMs: 3000 });
});
afterAll(() => {
  client.close();
  ha.close();
});

describe("HassClient", () => {
  it("runs WebSocket commands over one authenticated connection", async () => {
    const [config, areas] = await Promise.all([client.command("get_config"), client.command("config/area_registry/list")]);
    expect(config.version).toBe("2026.11.1");
    expect(areas).toHaveLength(3);
  });

  it("surfaces WebSocket errors", async () => {
    await expect(client.command("config/entity_registry/get", { entity_id: "light.nope" })).rejects.toThrow(/not found/);
  });

  it("calls the REST API", async () => {
    const s = await client.rest("GET", "/states/light.kitchen");
    expect(s.state).toBe("on");
    await expect(client.rest("GET", "/states/light.nope")).rejects.toThrow(/404/);
  });

  it("unwraps Supervisor responses and reads text logs", async () => {
    expect(await client.supervisor("GET", "/supervisor/info")).toEqual({ version: "2026.11.0" });
    const logs = await client.supervisor("GET", "/core/logs", undefined, "text/plain");
    expect(logs).toContain("ERROR line 0");
  });

  it("refuses path traversal", async () => {
    await expect(client.rest("GET", "/../supervisor/info")).rejects.toThrow(/Invalid/);
  });

  it("fails cleanly with a wrong token", async () => {
    const bad = new HassClient({ ...urls, token: "nope", timeoutMs: 2000 });
    await expect(bad.command("get_config")).rejects.toThrow(/rejected/);
    bad.close();
  });
});
