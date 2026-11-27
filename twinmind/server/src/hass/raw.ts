/**
 * What a call to one of the raw escape hatches (ha_websocket, ha_rest) actually does, so that
 * it can be treated like the specific tools instead of always asking:
 *
 * - read: only reads; runs without approval in every mode.
 * - change: an ordinary change (delete an integration, create an area, ...); follows the
 *   chat's mode like the specific tools, and "Always" applies to this one command.
 * - sensitive: users, tokens, sign-in, Supervisor, backups, cloud, OAuth credentials. Asks
 *   every time unless the mode never asks (Full access / Bypass); "Always" never applies.
 */
export type RawKind = "read" | "change" | "sensitive";

export interface RawCall {
  kind: RawKind;
  /** What "Always" remembers: this command, not every raw call. */
  key: string;
}

/** Reads that the patterns below would not recognise. */
const WS_READS = new Set([
  "get_states",
  "get_config",
  "get_services",
  "get_panels",
  "backup/info",
  "search/related",
  "integration/descriptions",
  "lovelace/resources",
  "config_entries/flow/progress",
  "trace/contexts",
]);

/** Commands under these prefixes are sensitive, whatever they do. */
const WS_SENSITIVE = ["auth/", "config/auth", "hassio/", "supervisor/", "backup/", "cloud/", "application_credentials/"];

/** The last part of the command name says it only reads: config_entries/get, lovelace/config, ... */
const WS_READ_NAME = /(^|\/)(get(_[a-z_]+)?|list(_[a-z_]+)?|info|[a-z_]+_info|config|log_info|descriptions)$/;

const REST_SENSITIVE = ["/auth", "/hassio", "/cloud", "/onboarding", "/config/auth", "/backup"];

export function classifyRaw(tool: string, args: any): RawCall | null {
  if (tool === "ha_websocket") {
    const type = String(args?.type ?? "");
    const key = `ha_websocket ${type}`;
    if (WS_READS.has(type)) return { kind: "read", key };
    if (WS_SENSITIVE.some((p) => type.startsWith(p))) return { kind: "sensitive", key };
    if (WS_READ_NAME.test(type)) return { kind: "read", key };
    return { kind: "change", key };
  }
  if (tool === "ha_rest") {
    const method = String(args?.method ?? "").toUpperCase();
    const raw = String(args?.path ?? "");
    // "//hassio/x" reaches /hassio/x too: compare with repeated slashes collapsed.
    const path = raw.toLowerCase().split("?")[0].replace(/\/{2,}/g, "/");
    const key = `ha_rest ${method} ${raw}`;
    // Anything that could step out of the path it names (../, encoded characters) is sensitive.
    if (/\.\.|%|\\/.test(path) || REST_SENSITIVE.some((p) => path === p || path.startsWith(`${p}/`))) return { kind: "sensitive", key };
    if (method === "GET") return { kind: "read", key };
    return { kind: "change", key };
  }
  return null;
}
