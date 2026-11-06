import type { ProviderId } from "../protocol.js";

/**
 * What happens when an assistant wants to change something in Home Assistant
 * (any non-read-only HA tool), depending on the chat's permission mode.
 *
 * - allow: run it (the user picked a "no questions asked" mode)
 * - ask: show an approval card
 * - read-only: refuse, the mode does not allow changes
 * - deny: refuse, the mode never asks and nothing is pre-approved
 */
export type HaPolicy = "allow" | "ask" | "read-only" | "deny";

export function haPolicy(provider: ProviderId, mode: string): HaPolicy {
  if (provider === "claude") {
    if (mode === "bypassPermissions") return "allow";
    if (mode === "plan") return "read-only";
    if (mode === "dontAsk") return "deny";
    return "ask"; // default, acceptEdits, auto
  }
  if (provider === "codex") {
    if (mode === "full-access") return "allow";
    if (mode === "read-only") return "read-only";
    return "ask"; // untrusted, auto
  }
  if (mode === "auto") return "allow";
  return "ask";
}
