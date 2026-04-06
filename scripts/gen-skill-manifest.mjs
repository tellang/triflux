import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFrontmatter } from "./lib/skill-template.mjs";

function collectSkillDirs(skillsDir) {
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => ({
      name: entry.name,
      dir: join(skillsDir, entry.name),
    }))
    .filter(({ dir }) => existsSync(join(dir, "SKILL.md")))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function extractManifest(skillMdContent) {
  const { data } = parseFrontmatter(skillMdContent);
  if (!data.name) return null;

  const manifest = { name: data.name };
  if (data.description) manifest.description = data.description;
  if (data.triggers) manifest.triggers = data.triggers;
  if (data["argument-hint"]) manifest.argument_hint = data["argument-hint"];
  if (data.internal === true || data.internal === "true") manifest.internal = true;

  return manifest;
}

export function generateSkillManifests({ skillsDir, write = true } = {}) {
  if (!skillsDir) throw new Error("skillsDir is required");

  const skillDirs = collectSkillDirs(skillsDir);
  const generated = [];

  for (const { name, dir } of skillDirs) {
    const skillMdPath = join(dir, "SKILL.md");
    const content = readFileSync(skillMdPath, "utf8");
    const manifest = extractManifest(content);

    if (!manifest) continue;

    const manifestPath = join(dir, "skill.json");
    const json = JSON.stringify(manifest, null, 2) + "\n";

    if (write) {
      const existing = existsSync(manifestPath)
        ? readFileSync(manifestPath, "utf8")
        : null;
      if (existing !== json) {
        writeFileSync(manifestPath, json, "utf8");
      }
    }

    generated.push({ name, manifestPath, manifest });
  }

  return { generated, count: generated.length };
}

function runCli() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..");
  const skillsDir = join(repoRoot, "skills");

  const result = generateSkillManifests({ skillsDir });
  console.log(`Generated ${result.count} skill.json file(s).`);
}

const isDirectRun = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  try {
    runCli();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[gen-skill-manifest] ${message}`);
    process.exitCode = 1;
  }
}
