// hub/fullcycle.mjs — tfx-fullcycle runtime artifact/state helpers

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ensureTfxDirs, TFX_FULLCYCLE_DIR, TFX_PLANS_DIR } from './paths.mjs';

function safeResolve(baseDir, relativePath) {
  const base = resolve(baseDir);
  const target = resolve(join(baseDir, relativePath));
  if (!target.startsWith(base)) {
    throw new Error('Invalid fullcycle path: path traversal detected');
  }
  return target;
}

/** @experimental 런타임 미연결 — Fullcycle 아티팩트 관리, 향후 통합 예정 */
export function createFullcycleRunId(now = new Date()) {
  return now
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .replace('Z', 'Z');
}

export function getFullcycleRunDir(runId, baseDir = process.cwd()) {
  return safeResolve(baseDir, join(TFX_FULLCYCLE_DIR, runId));
}

export function ensureFullcycleRunDir(runId, baseDir = process.cwd()) {
  ensureTfxDirs(baseDir);
  const dir = getFullcycleRunDir(runId, baseDir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveFullcycleArtifact(runId, filename, content, baseDir = process.cwd()) {
  if (!filename || typeof filename !== 'string') {
    throw new Error('Artifact filename is required');
  }

  const dir = ensureFullcycleRunDir(runId, baseDir);
  const path = safeResolve(dir, filename);
  writeFileSync(path, content, 'utf8');
  return path;
}

export function readFullcycleArtifact(runId, filename, baseDir = process.cwd()) {
  const dir = getFullcycleRunDir(runId, baseDir);
  const path = safeResolve(dir, filename);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

export function writeFullcycleState(runId, state, baseDir = process.cwd()) {
  const payload = typeof state === 'object' && state !== null ? state : {};
  const serialized = JSON.stringify(payload, null, 2);
  return saveFullcycleArtifact(runId, 'state.json', serialized, baseDir);
}

export function readFullcycleState(runId, baseDir = process.cwd()) {
  const content = readFullcycleArtifact(runId, 'state.json', baseDir);
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function findLatestInterviewPlan(baseDir = process.cwd()) {
  const plansDir = safeResolve(baseDir, TFX_PLANS_DIR);
  if (!existsSync(plansDir)) return null;

  const candidates = readdirSync(plansDir)
    .filter((name) => /^interview-.*\.md$/i.test(name))
    .map((name) => {
      const path = join(plansDir, name);
      const stats = statSync(path);
      return { name, path, mtimeMs: stats.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return candidates[0]?.path || null;
}

export function shouldStopQaLoop(failureHistory = [], maxRepeats = 3) {
  if (!Array.isArray(failureHistory) || maxRepeats <= 1) return false;

  const normalized = failureHistory
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean);

  if (normalized.length < maxRepeats) return false;
  const target = normalized.at(-1);
  const tail = normalized.slice(-maxRepeats);
  return tail.every((entry) => entry === target);
}
