import { afterEach, describe, expect, it } from "vitest";
import { agentEnv } from "./env.js";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("agentEnv", () => {
  it("never passes Twinmind's secrets to the assistants", () => {
    process.env.SUPERVISOR_TOKEN = "s";
    process.env.HASSIO_TOKEN = "h";
    process.env.TWINMIND_MCP_SECRET = "m";
    process.env.HOME = "/data/home";
    const env = agentEnv();
    expect(env.SUPERVISOR_TOKEN).toBeUndefined();
    expect(env.HASSIO_TOKEN).toBeUndefined();
    expect(env.TWINMIND_MCP_SECRET).toBeUndefined();
    expect(env.HOME).toBe("/data/home");
  });
  it("adds explicit extras", () => {
    expect(agentEnv({ IS_SANDBOX: "1" }).IS_SANDBOX).toBe("1");
  });
});
