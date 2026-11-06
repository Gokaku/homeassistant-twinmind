/** Environment variables that must never reach the assistants or the commands they run. */
const SECRET_VARS = ["SUPERVISOR_TOKEN", "HASSIO_TOKEN", "TWINMIND_MCP_SECRET"];

/**
 * The environment for Claude / Codex processes: everything except Twinmind's own secrets.
 * The Supervisor token in particular would let any command an assistant runs call the
 * Home Assistant API directly, bypassing Twinmind's approval gate.
 */
export function agentEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SECRET_VARS.includes(k)) env[k] = v;
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}
