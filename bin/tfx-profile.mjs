#!/usr/bin/env node
import { dirname, join } from "node:path";
// tfx-profile — Codex Profile Manager TUI entry point
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
await import(join(root, "tui", "codex-profile.mjs"));
