// hub/team/synapse-cli.mjs — CLI surface for Synapse v1.
// Reads persisted registry state + git log for the "status" and "why" commands.
// Hub integration comes later; for v1 we go straight to the JSON persist files
// so the CLI works even when Hub is offline.

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { parseIntentTrailer } from "./swarm-intent.mjs";

const DEFAULT_REGISTRY_CANDIDATES = [
  ".triflux/synapse-registry.json",
  ".triflux/synapse/registry.json",
  join(homedir(), ".claude", "cache", "tfx-hub", "synapse-registry.json"),
];

function gitExec(args, cwd) {
  return new Promise((res, rej) => {
    execFile(
      "git",
      args,
      { cwd, windowsHide: true, timeout: 15_000 },
      (err, stdout) => {
        if (err) rej(err);
        else res(stdout);
      },
    );
  });
}

function locateRegistryPath(explicit) {
  if (explicit && existsSync(explicit)) return explicit;
  for (const candidate of DEFAULT_REGISTRY_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function loadRegistrySnapshot(path) {
  if (!path) return [];
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") {
      // Accept both array-form and object-form persist layouts.
      if (Array.isArray(parsed.sessions)) return parsed.sessions;
      return Object.values(parsed);
    }
    return [];
  } catch {
    return [];
  }
}

function formatStatus(sessions) {
  if (!sessions.length) {
    return "no active sessions (synapse-registry empty)";
  }
  const rows = [];
  rows.push("SESSION                HOST    BRANCH    DIRTY   STATE    TASK");
  rows.push(
    "─────────────────────  ──────  ────────  ──────  ───────  ─────────────",
  );
  for (const s of sessions) {
    const id = (s.sessionId || "?").padEnd(21).slice(0, 21);
    const host = (s.host || "?").padEnd(6).slice(0, 6);
    const branch = (s.branch || "?").padEnd(8).slice(0, 8);
    const dirty = String((s.dirtyFiles || []).length)
      .padEnd(6)
      .slice(0, 6);
    const state = (s.status || "active").padEnd(7).slice(0, 7);
    const task = (s.taskSummary || "").slice(0, 40);
    rows.push(`${id}  ${host}  ${branch}  ${dirty}  ${state}  ${task}`);
  }
  return rows.join("\n");
}

/**
 * `tfx synapse status` — list active swarm sessions from persisted registry.
 */
export async function cmdSynapseStatus(args = [], opts = {}) {
  const jsonOut = args.includes("--json") || opts.json;
  const explicit = extractFlag(args, "--registry");
  const path = locateRegistryPath(explicit);
  const sessions = loadRegistrySnapshot(path);

  if (jsonOut) {
    process.stdout.write(
      JSON.stringify(
        { registry: path, count: sessions.length, sessions },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  if (!path) {
    process.stdout.write(
      "no registry file found (looked for .triflux/synapse-registry.json)\n",
    );
    return;
  }
  process.stdout.write(`registry: ${path}\n`);
  process.stdout.write(`${formatStatus(sessions)}\n`);
}

function extractFlag(args, name) {
  const idx = args.indexOf(name);
  if (idx < 0) return null;
  return args[idx + 1] || null;
}

async function resolveCommitForPath(path, cwd) {
  try {
    const out = await gitExec(["log", "-1", "--format=%H", "--", path], cwd);
    return out.trim();
  } catch {
    return "";
  }
}

async function readCommitMessage(sha, cwd) {
  try {
    return await gitExec(["log", "-1", "--format=%B", sha], cwd);
  } catch {
    return "";
  }
}

async function readCommitMeta(sha, cwd) {
  try {
    const out = await gitExec(
      ["log", "-1", "--format=%h%x1f%an%x1f%ad%x1f%s", "--date=iso", sha],
      cwd,
    );
    const [short, author, date, subject] = out.trim().split("\x1f");
    return { short, author, date, subject };
  } catch {
    return null;
  }
}

/**
 * `tfx why <path>` — show the X-Intent of the last commit touching <path>.
 */
export async function cmdSynapseWhy(args = [], opts = {}) {
  const jsonOut = args.includes("--json") || opts.json;
  const cwd = process.cwd();
  const positional = args.filter((a) => !a.startsWith("--"));
  const target = positional[0];

  if (!target) {
    const err = { error: "path required", usage: "tfx why <path>" };
    if (jsonOut) process.stdout.write(JSON.stringify(err) + "\n");
    else process.stderr.write("tfx why <path> — path 인자 필요\n");
    process.exitCode = 1;
    return;
  }

  const resolved = resolve(cwd, target);
  if (!existsSync(resolved)) {
    const err = { error: "path not found", path: target };
    if (jsonOut) process.stdout.write(JSON.stringify(err) + "\n");
    else process.stderr.write(`tfx why: 파일 없음: ${target}\n`);
    process.exitCode = 1;
    return;
  }

  const sha = await resolveCommitForPath(target, cwd);
  if (!sha) {
    const result = { path: target, commit: null, intent: null };
    if (jsonOut) process.stdout.write(JSON.stringify(result) + "\n");
    else process.stdout.write(`no commit touches ${target}\n`);
    return;
  }

  const [message, meta] = await Promise.all([
    readCommitMessage(sha, cwd),
    readCommitMeta(sha, cwd),
  ]);
  const intent = parseIntentTrailer(message);

  if (jsonOut) {
    process.stdout.write(
      JSON.stringify(
        { path: target, commit: { sha, ...meta }, intent },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  const header = meta
    ? `${meta.short}  ${meta.author}  ${meta.date}  ${meta.subject}`
    : sha;
  process.stdout.write(`${target}\n`);
  process.stdout.write(`  last commit: ${header}\n`);
  if (intent) {
    process.stdout.write(`  intent.scope:      ${intent.scope || "-"}\n`);
    process.stdout.write(`  intent.action:     ${intent.action || "-"}\n`);
    process.stdout.write(`  intent.reason:     ${intent.reason || "-"}\n`);
    if (Array.isArray(intent.touches) && intent.touches.length) {
      process.stdout.write(
        `  intent.touches:    ${intent.touches.join(", ")}\n`,
      );
    }
    if (intent.invariant) {
      process.stdout.write(`  intent.invariant:  ${intent.invariant}\n`);
    }
    if (intent.conflictsWith) {
      process.stdout.write(`  intent.conflicts:  ${intent.conflictsWith}\n`);
    }
  } else {
    process.stdout.write("  intent: (no X-Intent trailer)\n");
  }
}
