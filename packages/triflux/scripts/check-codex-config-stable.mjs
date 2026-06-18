#!/usr/bin/env node
// scripts/check-codex-config-stable.mjs
//
// Wrapper that runs a command (default: npm test) and verifies that
// ~/.codex/config.toml is unchanged before vs after execution.
//
// Issue #193 회귀 가드 — production codex config 가 test/build 도중 mutate
// 되면 즉시 fail 하고 진단 정보를 출력한다. CI 또는 로컬 npm script 에서
// `npm run test:guard-codex-config` 처럼 호출한다.
//
// Issue #193 follow-up — `[hooks.state.*]` section whitelist:
//   oh-my-codex 는 codex CLI hooks 가 발화될 때마다 ~/.codex/config.toml 의
//   `[hooks.state."<hook-key>"]` section 의 trusted_hash 를 자동 갱신한다.
//   사용자가 npm test 도중 다른 터미널에서 codex 를 활성 사용 중이면 이
//   외부 mutation 이 false positive 로 잡힌다. 따라서 hooks.state-only
//   churn 은 informational warning 으로 분류하고 exit 0 으로 통과시킨다.
//   Codex plugin mode also auto-materializes OpenAI primary runtime plugin
//   registry sections (for example pdf@openai-primary-runtime); those are
//   likewise Codex-owned external churn, not triflux-owned MCP drift.
//   triflux 자체 mutation (e.g. tfx-hub URL drift) 은 기존대로 exit 2.
//
// Exit codes:
//   0  = config 안정. wrap 한 명령의 exit code 그대로 반환 (보통 0).
//        hooks.state/OpenAI runtime plugin churn 도 여기 포함
//        (informational warning 만 출력).
//   2  = triflux 가드가 잡아야 할 mutation 감지. wrap 한 명령의 exit code
//        와 무관하게 강제 fail.
//   N  = wrap 한 명령이 N 으로 끝남 (mutation 없음).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CODEX_CONFIG = join(homedir(), ".codex", "config.toml");
const EXPECTED_TFX_HUB_URL = "http://127.0.0.1:27888/mcp";
const HOOKS_STATE_PREFIX = "hooks.state.";
const OPENAI_PRIMARY_RUNTIME_MARKETPLACE =
  "marketplaces.openai-primary-runtime";
const OPENAI_PRIMARY_RUNTIME_PLUGIN_RE =
  /^plugins\."[^"]+@openai-primary-runtime"$/u;

function readTfxHubUrl(raw) {
  const headerMatch =
    /^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*(?:tfx-hub|"tfx-hub"|'tfx-hub')[ \t]*\][ \t]*\r?$/m.exec(
      raw,
    );
  if (!headerMatch) return null;
  const headerLineEnd = raw.indexOf("\n", headerMatch.index);
  const bodyStart = headerLineEnd === -1 ? raw.length : headerLineEnd + 1;
  const nextSectionRegex = /^[ \t]*\[/gm;
  nextSectionRegex.lastIndex = bodyStart;
  const nextSectionMatch = nextSectionRegex.exec(raw);
  const sectionEnd = nextSectionMatch ? nextSectionMatch.index : raw.length;
  const sectionBody = raw.slice(bodyStart, sectionEnd);
  const urlMatch =
    /^[ \t]*url[ \t]*=[ \t]*(?:"([^"]+)"|'([^']+)')[ \t]*(?:#.*)?\r?$/m.exec(
      sectionBody,
    );
  return urlMatch?.[1] ?? urlMatch?.[2] ?? "";
}

// Split a TOML payload into section blocks. Pre-header content (top-level
// keys, comments) becomes a single anonymous section with header "".
// Each returned section has `{ header, body }` — body is the raw text
// between this header and the next section header, used for byte-level
// equality comparison.
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
    // skip past header line + trailing newline (if present)
    lastIndex = match.index + match[0].length;
    if (raw[lastIndex] === "\n") lastIndex += 1;
  }
  sections.push({ header: currentHeader, body: raw.slice(lastIndex) });
  return sections;
}

// Classify which sections drifted between before / after payloads.
// Returns:
//   { hooksStateOnly: bool, externalChurnOnly: bool, changedSections: string[] }
//
// hooksStateOnly = true means every changed section header starts with
// "hooks.state." (the oh-my-codex managed area). Empty diff returns
// hooksStateOnly=false so callers don't accidentally whitelist "no change".
//
// externalChurnOnly additionally permits Codex-owned OpenAI primary runtime
// plugin registry sections. It remains false for empty diffs and for any
// triflux-owned or unknown section drift.
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
    if (header === "") continue; // preamble drift is rare and noisy — ignore
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
      tfxHubUrl: readTfxHubUrl(raw),
    };
  } catch {
    return { exists: false };
  }
}

// describeChange — kind + (sha-changed 시) hooksStateOnly 라벨 + message.
// 호출 측에서 hooksStateOnly 면 informational 처리, 아니면 mutation 으로
// 처리한다. 반환 null = 차이 없음.
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

function describePortDrift(snapshot) {
  if (!snapshot.exists) return null;
  if (snapshot.tfxHubUrl === null) return null;
  if (snapshot.tfxHubUrl === EXPECTED_TFX_HUB_URL) return null;
  return `tfx-hub url is ${JSON.stringify(snapshot.tfxHubUrl)}; expected ${JSON.stringify(EXPECTED_TFX_HUB_URL)}`;
}

// CLI entry only when this script is the main module — keeps unit tests
// import-safe.
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isMain) {
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
  const portDrift = describePortDrift(after);
  const hooksStateOnly =
    change?.kind === "sha-changed" && change.hooksStateOnly === true;
  const externalChurnOnly =
    change?.kind === "sha-changed" && change.externalChurnOnly === true;

  // External Codex-owned churn + port drift 없음 = informational warning + pass.
  // port drift 가 같이 잡혔으면 그건 triflux-owned section mutation 이라
  // 기존 fail path 를 탄다.
  if (externalChurnOnly && !portDrift) {
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

  if (change || portDrift) {
    process.stderr.write(
      [
        "",
        "=== CONFIG MUTATION DETECTED (#193 회귀) ===",
        `Path:    ${CODEX_CONFIG}`,
        `Change:  ${change?.message || "none"}`,
        change?.changedSections?.length
          ? `Sections: ${change.changedSections.join(", ")}`
          : null,
        portDrift ? `Port:    ${portDrift}` : null,
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
