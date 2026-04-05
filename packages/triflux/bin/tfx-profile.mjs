#!/usr/bin/env node
// tfx-profile — Codex Profile Manager TUI entry point
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
await import(join(root, "tui", "codex-profile.mjs"));
