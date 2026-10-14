import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  section,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";

export type Skill = {
  name: string;
  path: string;
};

export async function discoverSkills(root: string): Promise<Skill[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const directory = join(root, entry.name);
    const files = await readdir(directory);
    if (files.includes("SKILL.md")) {
      skills.push({ name: entry.name, path: join(directory, "SKILL.md") });
    }
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

export async function readSkill(skills: readonly Skill[], name: string): Promise<string> {
  const skill = skills.find((item) => item.name === name);
  if (skill === undefined) {
    throw new Error(`Unknown skill ${name}.`);
  }
  return readFile(skill.path, "utf8");
}

function textResult(text: string): ToolExecutionResult {
  return { content: [{ type: "text", text }] };
}

export async function skillsExtension(root = "./skills") {
  const skills = await discoverSkills(root);
  const names = skills.map((skill) => skill.name);
  const listSkills = defineTool({
    name: "list-skills",
    description: "List the project skills available for this agent.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async () =>
      textResult(names.length === 0 ? "No project skills are available." : names.join("\n")),
  });
  const readSkillTool = defineTool({
    name: "read-skill",
    description: "Read the complete SKILL.md for a project skill by name.",
    parameters: Type.Object({ name: Type.String({ minLength: 1 }) }),
    replay: "safe",
    execute: async (args) => textResult(await readSkill(skills, args.name)),
  });
  const prompt = [
    "Project skills are available through list-skills and read-skill.",
    names.length === 0
      ? "No project skills are currently installed."
      : `Available skills: ${names.join(", ")}.`,
    "Read a skill before using its instructions.",
  ].join(" ");
  return defineExtension({
    name: "project-skills",
    sections: [section("project-skills", () => prompt, { tag: false })],
    tools: [listSkills, readSkillTool],
    hooks: [],
  });
}
