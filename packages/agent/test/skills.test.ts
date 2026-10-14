import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { discoverSkills, readSkill, skillsExtension } from "../src/skills.js";

test("扫描技能目录并按名称读取 SKILL.md", async () => {
  const root = await mkdtemp(join(process.cwd(), ".scratch/skills-test-"));
  try {
    await mkdir(join(root, "beta"));
    await mkdir(join(root, "alpha"));
    await mkdir(join(root, "empty"));
    await writeFile(join(root, "beta", "SKILL.md"), "# beta\n", "utf8");
    await writeFile(join(root, "alpha", "SKILL.md"), "# alpha\n", "utf8");
    const skills = await discoverSkills(root);
    assert.deepEqual(
      skills.map((skill) => skill.name),
      ["alpha", "beta"],
    );
    assert.equal(await readSkill(skills, "alpha"), "# alpha\n");
    await assert.rejects(readSkill(skills, "missing"), /Unknown skill missing/);
    assert.equal(await readFile(skills[1]!.path, "utf8"), "# beta\n");
    const extension = await skillsExtension(root);
    assert.deepEqual(
      extension.tools?.map((tool) => tool.name),
      ["list-skills", "read-skill"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
