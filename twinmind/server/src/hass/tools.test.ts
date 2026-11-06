import { describe, expect, it } from "vitest";
import { tail } from "./tools.js";

describe("tail", () => {
  const log = ["10:00 INFO started", "10:01 ERROR Bridge unreachable", "10:02 WARNING slow", "10:03 info done"].join("\n");

  it("keeps the last lines that contain one of the terms, ignoring case", () => {
    expect(tail(log, 10, "error")).toBe("10:01 ERROR Bridge unreachable");
    expect(tail(log, 10, "error|warning")).toBe("10:01 ERROR Bridge unreachable\n10:02 WARNING slow");
    expect(tail(log, 1, "info")).toBe("10:03 info done");
    expect(tail(log, 2)).toBe("10:02 WARNING slow\n10:03 info done");
  });

  it("treats the filter as text, so an assistant cannot freeze the server with a regex", () => {
    const line = `2026-11-06 10:00:00 WARNING [homeassistant.components.sensor] ${"a".repeat(40)}`;
    const started = Date.now();
    // As a regular expression this backtracks for minutes on that single line.
    expect(tail(line, 10, "(.*a){20}x")).toBe("");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(tail("a (x) b", 10, "(x)")).toBe("a (x) b");
  });
});
