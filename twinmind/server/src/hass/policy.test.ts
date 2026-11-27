import { describe, expect, it } from "vitest";
import { haPolicy } from "./policy.js";

describe("haPolicy", () => {
  it("only runs changes unasked in the no-limits modes", () => {
    expect(haPolicy("claude", "bypassPermissions")).toBe("allow");
    expect(haPolicy("codex", "full-access")).toBe("allow");
  });
  it("asks in the normal and semi-automatic modes", () => {
    for (const m of ["default", "acceptEdits"]) expect(haPolicy("claude", m, false)).toBe("ask");
    expect(haPolicy("codex", "untrusted", false)).toBe("ask");
  });
  it("runs ordinary HA changes unasked in Auto, but asks for sensitive ones", () => {
    for (const p of ["claude", "codex"] as const) {
      expect(haPolicy(p, "auto", false)).toBe("allow");
      expect(haPolicy(p, "auto", true)).toBe("ask");
      expect(haPolicy(p, "auto")).toBe("ask");
    }
  });
  it("refuses in read-only modes", () => {
    expect(haPolicy("claude", "plan")).toBe("read-only");
    expect(haPolicy("codex", "read-only")).toBe("read-only");
    expect(haPolicy("claude", "dontAsk")).toBe("deny");
  });
  it("asks for unknown modes", () => {
    expect(haPolicy("claude", "something-new")).toBe("ask");
    expect(haPolicy("codex", "")).toBe("ask");
  });
});
