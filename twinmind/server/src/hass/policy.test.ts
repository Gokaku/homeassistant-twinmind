import { describe, expect, it } from "vitest";
import { haPolicy } from "./policy.js";

describe("haPolicy", () => {
  it("only runs changes unasked in the no-limits modes", () => {
    expect(haPolicy("claude", "bypassPermissions")).toBe("allow");
    expect(haPolicy("codex", "full-access")).toBe("allow");
  });
  it("asks in the normal and semi-automatic modes", () => {
    for (const m of ["default", "acceptEdits", "auto"]) expect(haPolicy("claude", m)).toBe("ask");
    for (const m of ["untrusted", "auto"]) expect(haPolicy("codex", m)).toBe("ask");
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
