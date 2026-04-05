#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createAdaptiveEngine } from '../hub/adaptive.mjs';

let engine = null;
let createEngine = createAdaptiveEngine;

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function inferProjectSlug(cwd = process.cwd()) {
  const packagePath = join(cwd, 'package.json');
  if (existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
      if (typeof pkg.name === 'string' && pkg.name.trim()) return pkg.name.trim();
    } catch {}
  }
  return basename(cwd) || 'default';
}

function getEngine() {
  if (engine) return engine;
  engine = createEngine({
    projectSlug: inferProjectSlug(),
    repoRoot: process.cwd(),
  });
  engine.startSession?.();
  return engine;
}

function buildErrorContext(event = {}) {
  return {
    exitCode: event.exitCode,
    stderr: String(event.stderr || '').slice(0, 500),
    tool: event.tool,
    command: String(event.command || '').slice(0, 200),
    timestamp: new Date().toISOString(),
  };
}

export default function hookAdaptiveCollector(event = {}) {
  if (Number(event.exitCode) === 0) return null;
  if (!event.tool || event.tool === 'Read') return null;

  const result = getEngine().handleError(buildErrorContext(event));
  if (result?.diagnosed) {
    console.error(`[adaptive] 에러 패턴 감지: ${result.rule?.id || 'unknown'}`);
    if (result.promoted) {
      console.error(`[adaptive] 규칙 승격 → Tier ${result.rule?.tier ?? '?'}`);
    }
  }
  return result;
}

export function __setAdaptiveCollectorFactoryForTests(factory) {
  createEngine = factory;
  engine = null;
}

export function __resetAdaptiveCollectorForTests() {
  createEngine = createAdaptiveEngine;
  engine = null;
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) return;
  try {
    hookAdaptiveCollector(JSON.parse(raw));
  } catch {}
}

const isEntrypoint = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntrypoint) {
  main();
}
