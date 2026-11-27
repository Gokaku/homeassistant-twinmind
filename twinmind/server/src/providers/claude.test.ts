import { describe, expect, it } from "vitest";
import { THINKING, modelsFromSdk, sessionOnly } from "./claude.js";

describe("sessionOnly", () => {
  it("keeps 'Always' approvals in the session instead of settings files", () => {
    const out = sessionOnly([
      { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls:*" }], behavior: "allow", destination: "localSettings" },
      { type: "addRules", rules: [{ toolName: "Edit" }], behavior: "allow", destination: "projectSettings" },
    ]);
    expect(out?.map((s) => s.destination)).toEqual(["session", "session"]);
  });
});

describe("THINKING", () => {
  it("asks for readable thinking summaries", () => {
    // Without display, claude 2.1.318 requests thinking without its text: empty "Thinking" blocks.
    expect(THINKING).toEqual({ type: "adaptive", display: "summarized" });
  });
});

describe("modelsFromSdk", () => {
  const all = ["low", "medium", "high", "xhigh", "max"] as const;
  it("lists exact models, marks the one behind Claude Code's Default row, no Default entry", () => {
    const out = modelsFromSdk([
      { value: "default", resolvedModel: "claude-fable-5-2", displayName: "Default (recommended)", description: "Fable 5.2", supportsEffort: true, supportedEffortLevels: [...all] },
      { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "Everyday", supportsEffort: true, supportedEffortLevels: [...all] },
      { value: "fable", resolvedModel: "claude-fable-5-2", displayName: "Fable 5.2", description: "Hardest tasks", supportsEffort: true, supportedEffortLevels: [...all] },
      // The same model again under its full id: listed once.
      { value: "claude-fable-5-2", resolvedModel: "claude-fable-5-2", displayName: "Fable 5.2", description: "" },
      { value: "claude-haiku-4-5", displayName: "Haiku 4.5", description: "Old" },
    ]);
    expect(out.map((m) => [m.id, m.label, !!m.isDefault])).toEqual([
      ["opus", "Opus 5.5", false],
      ["fable", "Fable 5.2", true],
      ["claude-haiku-4-5", "Haiku 4.5", false],
    ]);
    expect(out[0].efforts?.map((e) => e.id)).toEqual([...all]);
    expect(out[0].defaultEffort).toBe("high");
    // No effort support: no thinking picker for that model.
    expect(out[2].efforts).toBeUndefined();
  });

  it("keeps the default model when only the Default row names it", () => {
    const out = modelsFromSdk([
      { value: "default", resolvedModel: "claude-x-1", displayName: "Default", description: "X 1", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
      { value: "sonnet", resolvedModel: "claude-sonnet-9", displayName: "Sonnet 9", description: "" },
    ]);
    expect(out[0]).toMatchObject({ id: "claude-x-1", label: "X 1", isDefault: true, defaultEffort: "high" });
  });
});
