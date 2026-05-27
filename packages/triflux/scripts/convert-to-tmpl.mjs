#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEPRECATION_MESSAGE =
  "SKILL.md.tmpl conversion is deprecated. Keep skills/**/SKILL.md as the single source of truth.";

export function convertToTemplates() {
  return {
    converted: 0,
    skipped: 0,
    deprecated: true,
    message: DEPRECATION_MESSAGE,
  };
}

const isDirectRun = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  const result = convertToTemplates();
  console.warn(`[convert-to-tmpl] ${result.message}`);
  console.warn("[convert-to-tmpl] No files were converted.");
}
