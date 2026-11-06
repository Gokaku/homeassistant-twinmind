import type { ChatMessage, Conversation, ProviderId } from "./protocol.js";

const LABEL: Record<ProviderId, string> = { claude: "Claude", codex: "Codex", mock: "Mock" };
const MAX_CHARS = 24_000;

function renderMessage(m: ChatMessage): string {
  const who = m.role === "user" ? "User" : LABEL[m.provider] ?? m.provider;
  const lines: string[] = [];
  for (const p of m.parts) {
    if (p.type === "text" && p.text.trim()) lines.push(p.text.trim());
    else if (p.type === "tool") lines.push(`[${p.kind === "command" ? "ran" : "used " + p.name}: ${p.title}${p.state === "error" ? " (failed)" : ""}]`);
    else if (p.type === "file") lines.push(`[attached file: ${p.name}]`);
  }
  return lines.length ? `${who}: ${lines.join("\n")}` : "";
}

/** Render messages as a plain transcript, keeping the most recent part if it is too long. */
export function renderTranscript(messages: ChatMessage[], maxChars = MAX_CHARS): string {
  const blocks = messages.map(renderMessage).filter(Boolean);
  let out = blocks.join("\n\n");
  if (out.length > maxChars) out = "[…earlier conversation omitted…]\n\n" + out.slice(out.length - maxChars);
  return out;
}

/**
 * Build the prompt for `provider`. If the provider has not seen some of the
 * conversation (because another provider handled those turns, or it never took
 * part), prepend those turns as context so it can pick up where things stand.
 *
 * `history` is the conversation *before* the new user message.
 */
export function buildPrompt(conv: Conversation, history: ChatMessage[], provider: ProviderId, userText: string): string {
  const seen = conv.native[provider] ? conv.seen[provider] ?? 0 : 0;
  const missed = history.slice(seen);
  if (missed.length === 0) return userText;
  const transcript = renderTranscript(missed);
  if (!transcript) return userText;
  const intro = conv.native[provider]
    ? "While you were away, the conversation continued with another assistant. Here is what happened since your last reply:"
    : "You are joining a conversation that is already in progress (with the user and possibly another AI assistant). Here is the transcript so far:";
  return `${intro}\n\n<transcript>\n${transcript}\n</transcript>\n\nThe user's new message:\n\n${userText}`;
}
