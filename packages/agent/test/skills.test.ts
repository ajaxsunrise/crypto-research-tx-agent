import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";

import { discoverSkills, readSkill, skillsExtension } from "../src/skills.js";

test("扫描技能目录并按名称读取 SKILL.md", async () => {
  const root = await mkdtemp(join(process.cwd(), ".scratch/skills-test-"));
  const outside = await mkdtemp(join(process.cwd(), ".scratch/skills-outside-"));
  try {
    await mkdir(join(root, "beta"));
    await mkdir(join(root, "alpha"));
    await mkdir(join(root, "empty"));
    await writeFile(join(root, "beta", "SKILL.md"), "# beta\n", "utf8");
    await writeFile(join(root, "alpha", "SKILL.md"), "# alpha\n", "utf8");
    // skills CLI 安装的技能是指向目录之外目标的符号链接
    await writeFile(join(outside, "SKILL.md"), "# linked\n", "utf8");
    await symlink(`../${basename(outside)}`, join(root, "linked"));
    const skills = await discoverSkills(root);
    assert.deepEqual(
      skills.map((skill) => skill.name),
      ["alpha", "beta", "linked"],
    );
    assert.equal(await readSkill(skills, "alpha"), "# alpha\n");
    assert.equal(await readSkill(skills, "linked"), "# linked\n");
    await assert.rejects(readSkill(skills, "missing"), /Unknown skill missing/);
    assert.equal(await readFile(skills[1]!.path, "utf8"), "# beta\n");
    const extension = await skillsExtension(root);
    assert.deepEqual(
      extension.tools?.map((tool) => tool.name),
      ["list-skills", "read-skill"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
