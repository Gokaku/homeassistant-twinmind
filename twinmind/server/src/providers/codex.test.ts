import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findProjectCodexConfig } from "./codex.js";

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
