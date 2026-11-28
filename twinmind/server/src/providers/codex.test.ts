import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexProvider, findProjectCodexConfig, modelsFromList, sandboxPolicyFor, threadConfig } from "./codex.js";
import { pickModel } from "./models.js";

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

  it("has Codex's reviewer check HA changes in Auto only", () => {
    const mcp = { url: "http://127.0.0.1:1/mcp/token" };
    // Outside Auto, Twinmind alone decides; in Full access Codex would otherwise block HA
    // changes ("requires approval, but approval policy is never", codex 0.172).
    for (const mode of ["read-only", "untrusted", "full-access"])
      expect(threadConfig(mcp, mode)).toMatchObject({ mcp_servers: { homeassistant: { default_tools_approval_mode: "approve" } } });
    // In Auto, Codex's default for tools that are not read-only applies: auto_review checks them.
    expect((threadConfig(mcp, "auto") as any).mcp_servers.homeassistant).not.toHaveProperty("default_tools_approval_mode");
  });

  it("turns off everything that keeps working after the turn ended", () => {
    // Verified with codex 0.166: sub-agents and goals both ran on unattended, with the
    // sandbox of an earlier Full access turn.
    expect(threadConfig(undefined)).toMatchObject({ features: { multi_agent: false, multi_agent_v2: false, goals: false } });
  });
});

describe("models and thinking levels", () => {
  const list = modelsFromList({
    data: [
      { id: "a", model: "gpt-a", displayName: "GPT A", hidden: false, isDefault: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }, { reasoningEffort: "medium" }, { reasoningEffort: "xhigh" }] },
      { id: "b", model: "gpt-b", displayName: "GPT B", hidden: false, isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] },
      { id: "c", model: "gpt-c", displayName: "Hidden", hidden: true, isDefault: false, supportedReasoningEfforts: [] },
    ],
  });

  it("lists the real models, no vague Default entry, with their thinking levels", () => {
    expect(list.map((m) => m.id)).toEqual(["gpt-a", "gpt-b"]);
    expect(list.find((m) => m.isDefault)?.id).toBe("gpt-b");
    expect(list[0].efforts).toEqual([
      { id: "low", label: "Low", description: "Fast" },
      { id: "medium", label: "Medium", description: undefined },
      { id: "xhigh", label: "Extra high", description: undefined },
    ]);
    expect(list[0].defaultEffort).toBe("medium");
  });

  it("marks the first model as default when Codex names none", () => {
    expect(modelsFromList({ data: [{ id: "x", model: "x", supportedReasoningEfforts: [] }] })[0]).toMatchObject({ isDefault: true, efforts: undefined });
  });

  it("always picks an explicit model and effort", () => {
    expect(pickModel(list, "gpt-a", "xhigh")).toEqual({ model: "gpt-a", effort: "xhigh" });
    // An effort the model does not support falls back to that model's default.
    expect(pickModel(list, "gpt-a", "high")).toEqual({ model: "gpt-a", effort: "medium" });
    // No or an unknown model: Codex's default model with its default effort.
    expect(pickModel(list, undefined, undefined)).toEqual({ model: "gpt-b", effort: "low" });
    expect(pickModel(list, "gone", "high")).toEqual({ model: "gpt-b", effort: "high" });
    // Without a model list (e.g. while signed out) nothing is invented.
    expect(pickModel([], "gpt-a", "high")).toEqual({ model: "gpt-a", effort: null });
  });
});

describe("sub-agents", () => {
  /** A provider with a fake app-server: threads have parents, calls are recorded. */
  function setup(parents: Record<string, string | null>) {
    const p: any = new CodexProvider({ cwd: "/config", bin: "/nonexistent" });
    const calls: [string, any][] = [];
    p.rpc = {
      call: async (m: string, params: any) => {
        if (m === "thread/read") return { thread: { id: params.threadId, parentThreadId: parents[params.threadId] ?? null } };
        calls.push([m, params]);
        return {};
      },
    };
    const turnFor = (thread: string) => {
      const turn = { agents: new Set<string>(), ctx: { emit: () => {} }, parts: new Map(), textItems: new Set(), flush: new Map() };
      p.turns.set(thread, turn);
      return turn;
    };
    const tick = () => new Promise((r) => setTimeout(r, 0));
    return { p, calls, turnFor, tick };
  }
  const started = (thread: string, turn: string) => ["turn/started", { threadId: thread, turn: { id: turn } }] as const;

  it("lets a turn's sub-agents work, also nested ones, and stops them all when the turn ends", async () => {
    const { p, calls, turnFor, tick } = setup({ a: "main", b: "a" });
    const turn = turnFor("main");
    p.onNotification(...started("a", "ta"));
    p.onNotification(...started("b", "tb")); // spawned by the sub-agent
    await tick();
    expect([...turn.agents].sort()).toEqual(["a", "b"]);
    expect(calls).toEqual([]);
    const emitted: any[] = [];
    turn.ctx.emit = (e: any) => emitted.push(e.part);
    turn.parts.set("agent:a", { type: "tool", id: "agent:a", name: "collaboration.spawn_agent", kind: "agent", title: "Sub-agent a", state: "running" });
    p.turns.delete("main");
    p.stopAgentsOf(turn);
    expect(emitted).toEqual([expect.objectContaining({ id: "agent:a", state: "error", output: expect.stringContaining("Stopped") })]);
    expect(calls).toEqual([
      ["turn/interrupt", { threadId: "a", turnId: "ta" }],
      ["turn/interrupt", { threadId: "b", turnId: "tb" }],
    ]);
  });

  it("stops a sub-agent that starts working after its turn ended, and any turn that belongs to no running turn", async () => {
    const { p, calls, tick } = setup({ late: "main", stray: null });
    p.onNotification(...started("late", "t1")); // its Twinmind turn is over
    p.onNotification(...started("stray", "t2")); // e.g. something Codex started on its own
    await tick();
    expect(calls).toHaveLength(2);
    expect(calls).toContainEqual(["turn/interrupt", { threadId: "late", turnId: "t1" }]);
    expect(calls).toContainEqual(["turn/interrupt", { threadId: "stray", turnId: "t2" }]);
  });

  it("lets a later turn use a sub-agent again", async () => {
    const { p, calls, turnFor, tick } = setup({ a: "main" });
    p.onNotification(...started("a", "t1"));
    await tick();
    expect(calls).toHaveLength(1); // stopped: no running turn
    turnFor("main"); // the next reply in the same chat gives it a follow-up task
    p.onNotification(...started("a", "t2"));
    await tick();
    expect(calls).toHaveLength(1);
  });

  it("shows a sub-agent as one card that follows its progress", () => {
    const { p } = setup({});
    const activity = (kind: string) => ({ type: "subAgentActivity", id: `x-${kind}`, kind, agentThreadId: "slow", agentPath: "/root/slow" });
    expect(p.toolFromItem(activity("started"))).toMatchObject({ id: "agent:slow", kind: "agent", title: "Sub-agent slow", state: "running" });
    expect(p.toolFromItem(activity("completed"))).toMatchObject({ id: "agent:slow", state: "completed" });
  });
});
