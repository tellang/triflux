#!/usr/bin/env node
// #193 회귀 가드: 명령 실행 전후 ~/.codex/config.toml 변경을 검사해 무관한 변경은 exit 2로 실패한다.
// hooks.state.* 및 openai-primary-runtime 섹션은 Codex 런타임이 자체 갱신하므로 허용한다.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMainModule } from "../hub/lib/process-utils.mjs";

const CODEX_CONFIG = join(homedir(), ".codex", "config.toml");
const HOOKS_STATE_PREFIX = "hooks.state.";
const OPENAI_PRIMARY_RUNTIME_MARKETPLACE =
  "marketplaces.openai-primary-runtime";
const OPENAI_PRIMARY_RUNTIME_PLUGIN_RE =
  /^plugins\."[^"]+@openai-primary-runtime"$/u;

export function splitTomlSections(raw) {
  if (typeof raw !== "string") return [];
  const sections = [];
  const headerRegex = /^[ \t]*\[[ \t]*([^\]\n]+?)[ \t]*\][ \t]*\r?$/gm;
  let lastIndex = 0;
  let currentHeader = "";
  let match;
  while ((match = headerRegex.exec(raw)) !== null) {
    const body = raw.slice(lastIndex, match.index);
    sections.push({ header: currentHeader, body });
    currentHeader = match[1].trim();
    lastIndex = match.index + match[0].length;
    if (raw[lastIndex] === "\n") lastIndex += 1;
  }
  sections.push({ header: currentHeader, body: raw.slice(lastIndex) });
  return sections;
}

function isExternalChurnSection(header) {
  return (
    header.startsWith(HOOKS_STATE_PREFIX) ||
    header === OPENAI_PRIMARY_RUNTIME_MARKETPLACE ||
    OPENAI_PRIMARY_RUNTIME_PLUGIN_RE.test(header)
  );
}

export function classifySectionDiff(beforeRaw, afterRaw) {
  const beforeSections = splitTomlSections(beforeRaw);
  const afterSections = splitTomlSections(afterRaw);
  const beforeMap = new Map();
  for (const s of beforeSections) {
    beforeMap.set(s.header, s.body);
  }
  const afterMap = new Map();
  for (const s of afterSections) {
    afterMap.set(s.header, s.body);
  }
  const changed = new Set();
  for (const [header, body] of afterMap) {
    if (header === "") continue; // preamble 변경은 노이즈가 많아 무시한다.
    const prev = beforeMap.get(header);
    if (prev === undefined || prev !== body) changed.add(header);
  }
  for (const header of beforeMap.keys()) {
    if (header === "") continue;
    if (!afterMap.has(header)) changed.add(header);
  }
  const changedSections = Array.from(changed);
  const hooksStateOnly =
    changedSections.length > 0 &&
    changedSections.every((h) => h.startsWith(HOOKS_STATE_PREFIX));
  const externalChurnOnly =
    changedSections.length > 0 && changedSections.every(isExternalChurnSection);
  return { hooksStateOnly, externalChurnOnly, changedSections };
}

function snapshotConfig() {
  try {
    const stat = statSync(CODEX_CONFIG);
    const data = readFileSync(CODEX_CONFIG);
    const raw = data.toString("utf8");
    const sha = createHash("sha256").update(data).digest("hex");
    return {
      exists: true,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha,
      raw,
    };
  } catch {
    return { exists: false };
  }
}

export function describeChange(before, after) {
  if (!before.exists && !after.exists) return null;
  if (before.exists !== after.exists) {
    return {
      kind: before.exists ? "file-deleted" : "file-created",
      message: before.exists ? "file deleted" : "file created",
    };
  }
  if (before.sha !== after.sha) {
    const beforeRaw = typeof before.raw === "string" ? before.raw : "";
    const afterRaw = typeof after.raw === "string" ? after.raw : "";
    const { hooksStateOnly, externalChurnOnly, changedSections } =
      classifySectionDiff(beforeRaw, afterRaw);
    return {
      kind: "sha-changed",
      hooksStateOnly,
      externalChurnOnly,
      changedSections,
      message: `sha256 differs (size: ${before.size} → ${after.size})`,
    };
  }
  if (before.mtimeMs !== after.mtimeMs) {
    return {
      kind: "mtime-only",
      message: `mtime differs (${before.mtimeMs} → ${after.mtimeMs})`,
    };
  }
  return null;
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const command = argv.length > 0 ? argv : ["npm", "test"];

  const before = snapshotConfig();
  process.stderr.write(
    `[check-codex-config-stable] before: ${JSON.stringify({ ...before, raw: undefined })}\n`,
  );

  const result = spawnSync(command[0], command.slice(1), {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  const after = snapshotConfig();
  process.stderr.write(
    `[check-codex-config-stable] after: ${JSON.stringify({ ...after, raw: undefined })}\n`,
  );

  const change = describeChange(before, after);
  const hooksStateOnly =
    change?.kind === "sha-changed" && change.hooksStateOnly === true;
  const externalChurnOnly =
    change?.kind === "sha-changed" && change.externalChurnOnly === true;

  if (externalChurnOnly) {
    process.stderr.write(
      [
        "",
        hooksStateOnly
          ? "[check-codex-config-stable] hooks.state-only churn (whitelist)"
          : "[check-codex-config-stable] Codex external plugin churn (whitelist)",
        `Path:     ${CODEX_CONFIG}`,
        `Sections: ${(change.changedSections || []).join(", ") || "(none)"}`,
        hooksStateOnly
          ? "Reason:   oh-my-codex 가 codex CLI hook trust state 를 자동 갱신."
          : "Reason:   Codex plugin runtime 이 OpenAI primary runtime registry 를 자동 갱신.",
        "          triflux 외부 mutation 이므로 #193 가드의 false positive 다.",
        "Action:   informational only — pass-through.",
        "",
      ].join("\n"),
    );
    process.exit(result.status ?? 0);
  }

  if (change) {
    process.stderr.write(
      [
        "",
        "=== CONFIG MUTATION DETECTED (#193 회귀) ===",
        `Path:    ${CODEX_CONFIG}`,
        `Change:  ${change?.message || "none"}`,
        change?.changedSections?.length
          ? `Sections: ${change.changedSections.join(", ")}`
          : null,
        "Action:  즉시 backup 으로 복원 + mutation source 추적 필요.",
        "Context: https://github.com/tellang/triflux/issues/193",
        "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    process.exit(2);
  }

  process.exit(result.status ?? 0);
}
