import type { ProviderId } from "../protocol.js";

/**
 * What happens when an assistant wants to change something in Home Assistant
 * (any non-read-only HA tool), depending on the chat's permission mode.
 *
 * - allow: run it (the user picked a mode that makes changes without asking)
 * - ask: show an approval card
 * - read-only: refuse, the mode does not allow changes
 * - deny: refuse, the mode never asks and nothing is pre-approved
 */
export type HaPolicy = "allow" | "ask" | "read-only" | "deny";

/** `sensitive`: users, tokens, Supervisor, ... (see raw.ts); Auto asks for those. */
export function haPolicy(provider: ProviderId, mode: string, sensitive = true): HaPolicy {
  if (provider === "claude") {
    if (mode === "bypassPermissions") return "allow";
    if (mode === "plan") return "read-only";
    if (mode === "dontAsk") return "deny";
    // Auto: ordinary HA changes run unasked; sensitive ones (users, tokens, Supervisor, ...) ask.
    if (mode === "auto") return sensitive ? "ask" : "allow";
    return "ask"; // default, acceptEdits
  }
  if (provider === "codex") {
    if (mode === "full-access") return "allow";
    if (mode === "read-only") return "read-only";
    if (mode === "auto") return sensitive ? "ask" : "allow";
    return "ask"; // untrusted
  }
  if (mode === "auto") return "allow";
  return "ask";
}
