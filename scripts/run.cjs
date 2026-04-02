#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");
const { existsSync, readFileSync } = require("fs");
const { dirname, isAbsolute, join, resolve } = require("path");
const { homedir } = require("os");

function isValidPluginRoot(candidate) {
  return typeof candidate === "string"
    && candidate.trim().length > 0
    && existsSync(join(candidate.trim(), "hooks", "hook-orchestrator.mjs"));
}

function resolvePluginRoot() {
  const breadcrumb = join(homedir(), ".claude", "scripts", ".tfx-pkg-root");
  if (existsSync(breadcrumb)) {
    try {
      const value = readFileSync(breadcrumb, "utf8").trim();
      if (isValidPluginRoot(value)) return value;
    } catch {
      // breadcrumb 읽기 실패 시 다음 fallback
    }
  }

  if (isValidPluginRoot(process.env.CLAUDE_PLUGIN_ROOT)) return process.env.CLAUDE_PLUGIN_ROOT;
  return dirname(__dirname);
}

function resolveTargetPath(rawTarget) {
  if (!rawTarget || typeof rawTarget !== "string") return null;

  const pluginRoot = resolvePluginRoot();
  const trimmed = rawTarget.trim();

  if (trimmed.startsWith("${CLAUDE_PLUGIN_ROOT}/")) {
    return join(pluginRoot, trimmed.replace("${CLAUDE_PLUGIN_ROOT}/", ""));
  }

  if (trimmed.startsWith("/scripts/")) {
    return join(pluginRoot, trimmed.replace(/^\/+/, ""));
  }

  if (isAbsolute(trimmed)) return trimmed;
  return resolve(process.cwd(), trimmed);
}

const targetArg = process.argv[2];
if (!targetArg) {
  process.exit(0);
}

const targetPath = resolveTargetPath(targetArg);
if (!targetPath || !existsSync(targetPath)) {
  process.exit(0);
}

const stdinBuffer = (() => {
  try {
    return readFileSync(0);
  } catch {
    return Buffer.alloc(0);
  }
})();

try {
  execFileSync(process.execPath, [targetPath, ...process.argv.slice(3)], {
    env: process.env,
    stdio: ["pipe", "inherit", "inherit"],
    input: stdinBuffer,
    windowsHide: true
  });
  process.exit(0);
} catch (error) {
  if (typeof error?.status === "number") {
    process.exit(error.status);
  }
  process.exit(0);
}
