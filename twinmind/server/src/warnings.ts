/**
 * The Claude SDK warns on every reply that canUseTool is not consulted for the Home Assistant
 * tools. That is intended: those tools are pre-allowed in Claude because Twinmind's own MCP gate
 * approves or refuses every change. Drop just that warning so the add-on log stays readable.
 */
export const SILENCED_WARNINGS = new Set(["CLAUDE_SDK_CAN_USE_TOOL_SHADOWED"]);

function codeOf(args: unknown[]): unknown {
  const [a, b] = args;
  if (a && typeof a === "object") return (a as { code?: unknown }).code;
  return b;
}

export function silenceKnownWarnings(proc: Pick<NodeJS.Process, "emitWarning"> = process): void {
  const emit = proc.emitWarning;
  proc.emitWarning = function (warning: string | Error, ...args: unknown[]) {
    const code = typeof warning === "object" && "code" in warning ? (warning as { code?: unknown }).code : codeOf(args);
    if (typeof code === "string" && SILENCED_WARNINGS.has(code)) return;
    return (emit as (...a: unknown[]) => void).call(proc, warning, ...args);
  } as NodeJS.Process["emitWarning"];
}
