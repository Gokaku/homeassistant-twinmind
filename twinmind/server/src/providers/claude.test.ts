import { describe, expect, it } from "vitest";
import { THINKING, sessionOnly } from "./claude.js";

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
