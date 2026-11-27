import fs from "node:fs";
import path from "node:path";

/**
 * Project instructions and skills the user keeps in /config, for both assistants.
 *
 * Claude Code would only find them with its project settings enabled, and those also load
 * hooks and permission rules that an assistant could write for itself (Twinmind turns them
 * off). Codex reads AGENTS.md and the .agents/.codex skill folders on its own, but not
 * CLAUDE.md or .claude/skills. So Twinmind passes what each one would miss as plain text:
 * the notes themselves, and a list of skills to read when they fit.
 */

const NOTE_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
export const SKILL_ROOTS = [".agents/skills", ".claude/skills", ".codex/skills"] as const;
const MAX_NOTE_CHARS = 20_000;
const MAX_SKILLS = 60;

export interface Skill {
  name: string;
  description: string;
  /** Absolute path of the SKILL.md. */
  file: string;
  root: (typeof SKILL_ROOTS)[number];
}

function readSmall(file: string, max: number): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(st.size, max * 4));
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).toString("utf8").slice(0, max);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** name and description from a SKILL.md's YAML front matter. */
export function skillMeta(text: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const field = (key: string) => {
    const r = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(m[1]);
    return r ? r[1].trim().replace(/^(["'])(.*)\1$/, "$2") : undefined;
  };
  return { name: field("name"), description: field("description") };
}

export function findSkills(cwd: string): Skill[] {
  const out: Skill[] = [];
  for (const root of SKILL_ROOTS) {
    let dirs: string[];
    try {
      dirs = fs.readdirSync(path.join(cwd, root)).sort();
    } catch {
      continue;
    }
    for (const dir of dirs) {
      if (out.length >= MAX_SKILLS) return out;
      const file = path.join(cwd, root, dir, "SKILL.md");
      const text = readSmall(file, 4000);
      if (text === null) continue;
      const meta = skillMeta(text);
      out.push({
        name: (meta.name || dir).slice(0, 80),
        description: (meta.description || "").replace(/\s+/g, " ").slice(0, 300),
        file,
        root,
      });
    }
  }
  return out;
}

/**
 * Text appended to an assistant's instructions. `native` names what that assistant already
 * reads by itself, so it is not given twice.
 */
export function projectContext(cwd: string, native: { notes: readonly string[]; skillRoots: readonly string[] } = { notes: [], skillRoots: [] }): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const name of NOTE_FILES) {
    const text = readSmall(path.join(cwd, name), MAX_NOTE_CHARS)?.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    if (native.notes.includes(name)) continue;
    parts.push(`<project_notes source="${path.join(cwd, name)}">\n${text}\n</project_notes>`);
  }
  const skills = findSkills(cwd).filter((s) => !native.skillRoots.includes(s.root));
  if (skills.length) {
    parts.push(
      `<skills>\nThe user keeps these skills in ${cwd}. When a task matches one, read its SKILL.md first and follow it.\n` +
        skills.map((s) => `- ${s.name}: ${s.description || "(no description)"} (${s.file})`).join("\n") +
        `\n</skills>`,
    );
  }
  return parts.length ? `\n\n${parts.join("\n\n")}` : "";
}

/** What Codex reads from the working directory by itself (verified with codex 0.172). */
export const CODEX_NATIVE = { notes: ["AGENTS.md"], skillRoots: [".agents/skills", ".codex/skills"] } as const;
