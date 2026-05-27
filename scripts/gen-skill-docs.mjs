#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEPRECATION_MESSAGE =
  "SKILL.md.tmpl generation is deprecated. Use skills/**/SKILL.md as the single source of truth.";

export function generateSkillDocs({ skillsDir } = {}) {
  if (!skillsDir) throw new Error("skillsDir is required");

  return {
    generated: [],
    count: 0,
    deprecated: true,
    message: DEPRECATION_MESSAGE,
  };
}

function runCli() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..");
  const skillsDir = join(repoRoot, "skills");
  const result = generateSkillDocs({ skillsDir });

  console.warn(`[gen-skill-docs] ${result.message}`);
  console.warn("[gen-skill-docs] No files were generated.");
}

const isDirectRun = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  try {
    runCli();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[gen-skill-docs] ${message}`);
    process.exitCode = 1;
  }
}
