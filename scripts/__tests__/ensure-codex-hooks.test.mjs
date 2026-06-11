// ensure-codex-hooks 직렬화/멱등 회귀 테스트 (issue #394 배경)
//
// 핵심 계약:
// 1. 기록은 codex CLI 0.137+ canonical 인 table-header 형식만 사용한다.
// 2. strip/수렴 판정은 inline dotted-key / table-header 양 형식을 모두 인식한다.
// 3. 이미 수렴 상태면 config 를 재기록하지 않는다 (SessionStart 마다 호출되므로).
// 4. 어떤 입력 조합에서도 같은 키가 2회 직렬화되지 않는다 (TOML duplicate key
//    = codex 전 호출 즉사).
//
// 전부 mkdtemp 격리 — 실 ~/.codex 무접촉.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ensureCodexHooks } from "../ensure-codex-hooks.mjs";

const TEMP_DIRS = [];

function makeCodexHome() {
  const dir = mkdtempSync(join(tmpdir(), "tfx-ensure-codex-hooks-"));
  TEMP_DIRS.push(dir);
  return dir;
}

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    rmSync(TEMP_DIRS.pop(), { recursive: true, force: true });
  }
});

function countOccurrences(content, needle) {
  return content.split(needle).length - 1;
}

function managedKeyCounts(content, hooksPath) {
  const counts = {};
  for (const label of ["session_start", "user_prompt_submit"]) {
    const key = `${hooksPath}:${label}:0:0`;
    const inline = countOccurrences(content, `"${key}" = {`);
    const table = countOccurrences(content, `[hooks.state."${key}"]`);
    counts[label] = { inline, table, total: inline + table };
  }
  return counts;
}

describe("ensureCodexHooks — table-header 직렬화 + 멱등", () => {
  it("fresh install: table-header 형식으로 각 키 1회 기록", () => {
    const codexHome = makeCodexHome();
    const result = ensureCodexHooks({ codexHome, backupTimestamp: "t0" });

    assert.equal(result.skipped, false);
    assert.equal(result.changedHooks, true);
    assert.equal(result.changedConfig, true);

    const config = readFileSync(result.configPath, "utf8");
    const counts = managedKeyCounts(config, result.hooksPath);
    for (const label of ["session_start", "user_prompt_submit"]) {
      assert.equal(counts[label].table, 1, `${label} table 형식 1회`);
      assert.equal(counts[label].inline, 0, `${label} inline 형식 0회`);
    }
  });

  it("멱등: 2회 실행 시 changedConfig=false, 내용 불변", () => {
    const codexHome = makeCodexHome();
    const first = ensureCodexHooks({ codexHome, backupTimestamp: "t0" });
    const before = readFileSync(first.configPath, "utf8");

    const second = ensureCodexHooks({ codexHome, backupTimestamp: "t1" });
    assert.equal(second.changedConfig, false, "2회차 config 무변경");
    assert.equal(second.changedHooks, false, "2회차 hooks 무변경");
    assert.equal(readFileSync(first.configPath, "utf8"), before);
  });

  it("재발 시나리오: inline+table 이중화 config 를 단일 table 로 dedupe", () => {
    const codexHome = makeCodexHome();
    const first = ensureCodexHooks({ codexHome, backupTimestamp: "t0" });
    const config = readFileSync(first.configPath, "utf8");

    // 과거 설치기(inline)와 codex 재직렬화(table)가 공존하는 오염 상태 재현:
    // 현재 table 기록 위에, 같은 키/해시의 inline 라인을 [hooks.state] 헤더와
    // 함께 prepend 한다 — 2026-06-10 실측 config.toml:151-156 구조.
    const counts0 = managedKeyCounts(config, first.hooksPath);
    assert.equal(counts0.session_start.table, 1);
    const tableBlocks = config
      .split("\n")
      .filter((l) => l.includes("trusted_hash"));
    assert.ok(tableBlocks.length >= 2);
    const hashOf = (label) => {
      const idx = config.indexOf(
        `[hooks.state."${first.hooksPath}:${label}:0:0"]`,
      );
      const m = config.slice(idx).match(/trusted_hash = "([^"]+)"/);
      return m[1];
    };
    const polluted = [
      "[hooks.state]",
      `"${first.hooksPath}:session_start:0:0" = { trusted_hash = "${hashOf("session_start")}" }`,
      `"${first.hooksPath}:user_prompt_submit:0:0" = { trusted_hash = "${hashOf("user_prompt_submit")}" }`,
      config,
    ].join("\n");
    writeFileSync(first.configPath, polluted, "utf8");

    const second = ensureCodexHooks({ codexHome, backupTimestamp: "t1" });
    assert.equal(second.changedConfig, true, "오염 감지 시 재기록");
    const cleaned = readFileSync(first.configPath, "utf8");
    const counts = managedKeyCounts(cleaned, first.hooksPath);
    for (const label of ["session_start", "user_prompt_submit"]) {
      assert.equal(counts[label].total, 1, `${label} 총 1회 (duplicate 해소)`);
      assert.equal(counts[label].table, 1, `${label} table 형식으로 수렴`);
    }
  });

  it("codex 가 table 로만 재직렬화한 config 는 수렴 상태로 보고 무변경", () => {
    const codexHome = makeCodexHome();
    const first = ensureCodexHooks({ codexHome, backupTimestamp: "t0" });
    const config = readFileSync(first.configPath, "utf8");

    // codex 재직렬화 시뮬레이션: 동일 키/해시가 table 형식으로만 존재
    // (이미 우리 기록이 table 이므로 그대로가 그 상태다). 위에 무관 설정만 추가.
    writeFileSync(first.configPath, `model = "gpt-5.5"\n\n${config}`, "utf8");

    const second = ensureCodexHooks({ codexHome, backupTimestamp: "t1" });
    assert.equal(second.changedConfig, false, "수렴 상태 무변경");
    const after = readFileSync(first.configPath, "utf8");
    assert.ok(after.startsWith('model = "gpt-5.5"'), "비관리 설정 보존");
  });

  it("비관리 hooks.state 키(oh-my-codex 등)는 보존", () => {
    const codexHome = makeCodexHome();
    const configPath = join(codexHome, "config.toml");
    const foreign =
      '[hooks.state."oh-my-codex@local:hooks/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:aaaa"\n';
    writeFileSync(configPath, foreign, "utf8");

    const result = ensureCodexHooks({ codexHome, backupTimestamp: "t0" });
    const config = readFileSync(result.configPath, "utf8");
    assert.ok(
      config.includes("oh-my-codex@local:hooks/hooks.json:stop:0:0"),
      "외부 키 보존",
    );
    assert.equal(
      countOccurrences(config, "oh-my-codex@local"),
      1,
      "외부 키 중복 없음",
    );
    const counts = managedKeyCounts(config, result.hooksPath);
    assert.equal(counts.session_start.total, 1);
  });

  it("hash 불일치(stale trust) 시 양 형식 strip 후 table 1회 재기록", () => {
    const codexHome = makeCodexHome();
    const first = ensureCodexHooks({ codexHome, backupTimestamp: "t0" });
    const config = readFileSync(first.configPath, "utf8");
    // 해시를 임의 값으로 바꿔 stale trust 상태 재현
    writeFileSync(
      first.configPath,
      config.replace(
        /trusted_hash = "sha256:[0-9a-f]+"/g,
        'trusted_hash = "sha256:stale"',
      ),
      "utf8",
    );

    const second = ensureCodexHooks({ codexHome, backupTimestamp: "t1" });
    assert.equal(second.changedConfig, true);
    const after = readFileSync(first.configPath, "utf8");
    const counts = managedKeyCounts(after, first.hooksPath);
    for (const label of ["session_start", "user_prompt_submit"]) {
      assert.equal(counts[label].total, 1);
      assert.equal(counts[label].table, 1);
    }
    // 관리 키 영역은 stale 해시가 아닌 유효한 sha256 으로 갱신됐다
    assert.equal(
      countOccurrences(after, "sha256:stale"),
      0,
      "stale 해시 잔존 없음",
    );
    const m = after.match(/trusted_hash = "(sha256:[0-9a-f]{64})"/);
    assert.ok(m, "유효한 sha256 해시로 재기록");
  });
});
