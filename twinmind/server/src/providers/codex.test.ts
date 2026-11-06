import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findProjectCodexConfig, sandboxPolicyFor, threadConfig } from "./codex.js";

describe("findProjectCodexConfig", () => {
  it("finds a project config in the working directory or a parent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tm-codex-"));
    const cwd = path.join(root, "config");
    fs.mkdirSync(cwd);
    expect(findProjectCodexConfig(cwd)).toBeNull();
    fs.mkdirSync(path.join(root, ".codex"));
    fs.writeFileSync(path.join(root, ".codex", "config.toml"), "[mcp_servers.x]\ncommand='sh'\n");
    expect(findProjectCodexConfig(cwd)).toBe(path.join(root, ".codex", "config.toml"));
    fs.mkdirSync(path.join(cwd, ".codex"));
    fs.writeFileSync(path.join(cwd, ".codex", "config.toml"), "");
    expect(findProjectCodexConfig(cwd)).toBe(path.join(cwd, ".codex", "config.toml"));
    fs.rmSync(root, { recursive: true });
  });
});

describe("sandboxPolicyFor", () => {
  it("maps every mode to an explicit per-turn sandbox", () => {
    expect(sandboxPolicyFor("read-only", "/config")).toEqual({ type: "readOnly", networkAccess: false });
    expect(sandboxPolicyFor("untrusted", "/config")).toMatchObject({ type: "workspaceWrite", writableRoots: ["/config"], networkAccess: false });
    expect(sandboxPolicyFor("auto", "/config")).toMatchObject({ type: "workspaceWrite" });
    expect(sandboxPolicyFor("full-access", "/config")).toEqual({ type: "dangerFullAccess" });
    // Unknown modes fall back to the default (sandboxed), never to full access.
    expect(sandboxPolicyFor("nonsense", "/config")).toMatchObject({ type: "workspaceWrite" });
  });
});

describe("threadConfig", () => {
  it("keeps the MCP secret out of the commands Codex runs", () => {
    // Verified with codex 0.166: without this, `env` in any Codex command printed the secret.
    for (const mcp of [undefined, { url: "http://127.0.0.1:1/mcp/token" }]) {
      expect(threadConfig(mcp)).toMatchObject({ shell_environment_policy: { exclude: ["TWINMIND_MCP_SECRET"] } });
    }
    expect(threadConfig({ url: "http://127.0.0.1:1/mcp/token" })).toMatchObject({
      mcp_servers: { homeassistant: { url: "http://127.0.0.1:1/mcp/token", bearer_token_env_var: "TWINMIND_MCP_SECRET" } },
    });
  });

  it("turns off everything that keeps working after the turn ended", () => {
    // Verified with codex 0.166: sub-agents and goals both ran on unattended, with the
    // sandbox of an earlier Full access turn.
    expect(threadConfig(undefined)).toMatchObject({ features: { multi_agent: false, goals: false } });
  });
});
