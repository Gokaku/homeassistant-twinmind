import { describe, expect, it } from "vitest";
import { buildPrompt } from "./handoff.js";
import type { ChatMessage, Conversation } from "./protocol.js";

const msg = (role: "user" | "assistant", provider: "claude" | "codex", text: string): ChatMessage => ({
  id: Math.random().toString(36),
  role,
  provider,
  createdAt: 0,
  parts: [{ type: "text", id: "t", text }],
});

function conv(messages: ChatMessage[], extra: Partial<Conversation> = {}): Conversation {
  return { id: "c", title: "t", createdAt: 0, updatedAt: 0, provider: "claude", native: {}, seen: {}, messageCount: 0, messages, ...extra };
}

describe("buildPrompt", () => {
  it("sends the text unchanged on a fresh conversation", () => {
    expect(buildPrompt(conv([]), [], "claude", "hello")).toBe("hello");
  });

  it("sends the text unchanged when the provider has seen everything", () => {
    const h = [msg("user", "claude", "a"), msg("assistant", "claude", "b")];
    expect(buildPrompt(conv(h, { native: { claude: "s" }, seen: { claude: 2 } }), h, "claude", "next")).toBe("next");
  });

  it("gives a newcomer the full transcript", () => {
    const h = [msg("user", "claude", "draft an automation"), msg("assistant", "claude", "here it is")];
    const p = buildPrompt(conv(h, { native: { claude: "s" }, seen: { claude: 2 } }), h, "codex", "review it");
    expect(p).toContain("joining a conversation");
    expect(p).toContain("User: draft an automation");
    expect(p).toContain("Claude: here it is");
    expect(p.endsWith("review it")).toBe(true);
  });

  it("gives a returning provider only what it missed", () => {
    const h = [
      msg("user", "claude", "one"),
      msg("assistant", "claude", "two"),
      msg("user", "codex", "three"),
      msg("assistant", "codex", "four"),
    ];
    const p = buildPrompt(conv(h, { native: { claude: "s", codex: "t" }, seen: { claude: 2, codex: 4 } }), h, "claude", "five");
    expect(p).toContain("While you were away");
    expect(p).not.toContain("User: one");
    expect(p).toContain("Codex: four");
  });
});
