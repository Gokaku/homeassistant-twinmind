/** Helpers for turning tool calls into short, readable card titles. */

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function stringifyOutput(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : typeof c === "string" ? c : JSON.stringify(c)))
      .join("\n");
  }
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

/** A one-line description of a tool call, e.g. the command, file path or query. */
export function describeTool(name: string, input: any): string {
  const i = input ?? {};
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof i[k] === "string" && i[k].trim()) return i[k].trim();
    return "";
  };
  const v =
    pick("command", "file_path", "path", "notebook_path", "pattern", "query", "url", "description", "prompt", "plan") ||
    (Array.isArray(i.todos) ? `${i.todos.length} tasks` : "");
  return truncate((v || name).replace(/\s+/g, " "), 160);
}
