import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CODEX_NATIVE, findSkills, projectContext, skillMeta } from "./project.js";

function setup() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tm-project-"));
  const skill = (root: string, dir: string, front: string) => {
    fs.mkdirSync(path.join(cwd, root, dir), { recursive: true });
    fs.writeFileSync(path.join(cwd, root, dir, "SKILL.md"), `---\n${front}\n---\nBody.\n`);
  };
  return { cwd, skill };
}

describe("project notes and skills from /config", () => {
  it("reads name and description from the front matter", () => {
    expect(skillMeta('---\nname: glass-cards\ndescription: "Glass cards theme"\n---\nx')).toEqual({ name: "glass-cards", description: "Glass cards theme" });
    expect(skillMeta("no front matter")).toEqual({});
  });

  it("finds skills in the .agents, .claude and .codex folders", () => {
    const { cwd, skill } = setup();
    skill(".agents/skills", "glass", "name: glass-cards\ndescription: Glass cards");
    skill(".claude/skills", "theme", "description: Theme");
    skill(".codex/skills", "x", "name: x");
    fs.mkdirSync(path.join(cwd, ".agents/skills/empty"), { recursive: true }); // no SKILL.md
    expect(findSkills(cwd).map((s) => [s.root, s.name, s.description])).toEqual([
      [".agents/skills", "glass-cards", "Glass cards"],
      [".claude/skills", "theme", "Theme"],
      [".codex/skills", "x", ""],
    ]);
  });

  it("gives Claude everything, and Codex only what it does not read itself", () => {
    const { cwd, skill } = setup();
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), "agents notes");
    fs.writeFileSync(path.join(cwd, "CLAUDE.md"), "claude notes");
    skill(".agents/skills", "a", "name: a\ndescription: from agents");
    skill(".claude/skills", "c", "name: c\ndescription: from claude");
    const claude = projectContext(cwd);
    expect(claude).toContain("agents notes");
    expect(claude).toContain("claude notes");
    expect(claude).toContain("- a: from agents");
    expect(claude).toContain("- c: from claude");
    const codex = projectContext(cwd, CODEX_NATIVE);
    expect(codex).not.toContain("agents notes");
    expect(codex).toContain("claude notes");
    expect(codex).not.toContain("- a: from agents");
    expect(codex).toContain("- c: from claude");
  });

  it("gives the same notes once when CLAUDE.md repeats AGENTS.md, and nothing when there is nothing", () => {
    const { cwd } = setup();
    expect(projectContext(cwd)).toBe("");
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), "same");
    fs.writeFileSync(path.join(cwd, "CLAUDE.md"), "same");
    expect(projectContext(cwd).split("same").length - 1).toBe(1);
    // Codex reads AGENTS.md itself: the identical CLAUDE.md is not added either.
    expect(projectContext(cwd, CODEX_NATIVE)).toBe("");
  });
});
