#!/usr/bin/env node
/**
 * Converts SKILL.md files to SKILL.md.tmpl format.
 * - Replaces skill name in title with {{SKILL_NAME}}
 * - Removes expanded base block (ARGUMENTS + Telemetry)
 * - Inserts {{> base}} after the title line
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const SKILLS_DIR = join(import.meta.dirname, "..", "skills");

const BASE_BLOCK_RE =
  /\n> \*\*ARGUMENTS 처리\*\*.*?\n> 워크플로우의 첫 단계.*?기존 절차대로.*?\n\n> \*\*Telemetry\*\*\n>\n> - Skill:.*?\n> - Description:.*?\n> - Session:.*?\n> - Errors:.*?\n/s;

let converted = 0;
let skipped = 0;

for (const name of readdirSync(SKILLS_DIR)) {
  const dir = join(SKILLS_DIR, name);
  const skillMd = join(dir, "SKILL.md");
  const tmplMd = join(dir, "SKILL.md.tmpl");

  if (name.startsWith("_")) continue;
  if (!existsSync(skillMd)) continue;
  if (existsSync(tmplMd)) {
    skipped++;
    continue;
  }

  let content = readFileSync(skillMd, "utf8");

  // Replace skill name in title: # tfx-foo — Title -> # {{SKILL_NAME}} — Title
  content = content.replace(
    new RegExp(`^(# )${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( —)`, "m"),
    "$1{{SKILL_NAME}}$2",
  );

  // Remove expanded base block if present
  if (BASE_BLOCK_RE.test(content)) {
    content = content.replace(BASE_BLOCK_RE, "\n\n{{> base}}\n\n");
  } else {
    // Insert {{> base}} after the title line
    content = content.replace(/^(# .+\n)/, "$1\n{{> base}}\n");
  }

  writeFileSync(tmplMd, content);
  converted++;
  console.log(`✅ ${name}`);
}

console.log(
  `\nConverted: ${converted}, Skipped (already has .tmpl): ${skipped}`,
);
