import { describe, expect, it } from "vitest";
import { haPolicy } from "./policy.js";

describe("haPolicy", () => {
  it("only runs changes unasked in the no-limits modes", () => {
    expect(haPolicy("claude", "bypassPermissions")).toBe("allow");
    expect(haPolicy("codex", "full-access")).toBe("allow");
  });
  it("asks in the normal and semi-automatic modes", () => {
    for (const m of ["default", "acceptEdits", "auto"]) expect(haPolicy("claude", m)).toBe("ask");
    expect(haPolicy("codex", "untrusted", "ha_call_service")).toBe("ask");
  });
  it("runs regular HA changes unasked in Codex's Auto mode, but not raw API calls", () => {
    expect(haPolicy("codex", "auto", "ha_call_service")).toBe("allow");
    expect(haPolicy("codex", "auto", "ha_websocket")).toBe("ask");
    expect(haPolicy("codex", "auto", "ha_rest")).toBe("ask");
    expect(haPolicy("codex", "auto")).toBe("ask");
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
