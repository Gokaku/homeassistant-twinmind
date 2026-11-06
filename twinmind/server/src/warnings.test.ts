import { describe, expect, it, vi } from "vitest";
import { silenceKnownWarnings } from "./warnings.js";

describe("silenceKnownWarnings", () => {
  it("drops only the Claude SDK canUseTool warning", () => {
    const seen: unknown[][] = [];
    const proc = { emitWarning: vi.fn((...a: unknown[]) => void seen.push(a)) as any };
    silenceKnownWarnings(proc);
    proc.emitWarning("shadowed", { code: "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED" });
    proc.emitWarning("shadowed", "Warning", "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED");
    proc.emitWarning("other", { code: "OTHER" });
    proc.emitWarning("plain");
    expect(seen.map((a) => a[0])).toEqual(["other", "plain"]);
  });
});
