// tests/unit/tfx-route-duration.test.mjs
// #163: estimate_expected_duration_sec 한글 + 영어 키워드 regex 회귀 방지 unit test.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BASH_EXE, toBashPath } from "../helpers/bash-path.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..", "..");
const ROUTE_SCRIPT = resolve(PROJECT_ROOT, "scripts", "tfx-route.sh");

function extractFunction(scriptPath, funcName) {
  const content = fs.readFileSync(scriptPath, "utf8");
  const regex = new RegExp(`^${funcName}\\(\\)\\s*\\{[\\s\\S]*?\\n\\}`, "m");
  const match = content.match(regex);
  if (!match) throw new Error(`Function ${funcName} not found`);
  return match[0];
}

const FUNC = extractFunction(ROUTE_SCRIPT, "estimate_expected_duration_sec");

function estimate(agent, profile, prompt) {
  const script = `${FUNC}\nestimate_expected_duration_sec "${agent}" "${profile}" "${prompt}"`;
  const result = spawnSync(BASH_EXE, ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
  });
  return parseInt(result.stdout.trim(), 10);
}

describe("estimate_expected_duration_sec — agent 기본값", () => {
  it("explore = 30", () => {
    assert.equal(estimate("explore", "", ""), 30);
  });
  it("writer = 90", () => {
    assert.equal(estimate("writer", "", ""), 90);
  });
  it("executor = 300", () => {
    assert.equal(estimate("executor", "", ""), 300);
  });
  it("code-reviewer = 600", () => {
    assert.equal(estimate("code-reviewer", "", ""), 600);
  });
  it("scientist = 900", () => {
    assert.equal(estimate("scientist", "", ""), 900);
  });
  it("unknown agent = 30 (fallback)", () => {
    assert.equal(estimate("unknown-agent", "", ""), 30);
  });
});

describe("estimate_expected_duration_sec — profile bump", () => {
  it("explore + minimal → 60 (bump from 30)", () => {
    assert.equal(estimate("explore", "minimal", ""), 60);
  });
  it("explore + analyze → 300 (bump from 30)", () => {
    assert.equal(estimate("explore", "analyze", ""), 300);
  });
  it("executor + implement → 300 (no bump, already ≥ 300)", () => {
    assert.equal(estimate("executor", "implement", ""), 300);
  });
  it("scientist + implement → 900 (no downgrade)", () => {
    assert.equal(estimate("scientist", "implement", ""), 900);
  });
});

describe("estimate_expected_duration_sec — 한글 키워드 bump", () => {
  it('"분석" → 600', () => {
    assert.equal(estimate("explore", "", "코드 분석 해줘"), 600);
  });
  it('"리서치" → 600', () => {
    assert.equal(estimate("explore", "", "최신 동향 리서치"), 600);
  });
  it('"조사" → 600', () => {
    assert.equal(estimate("explore", "", "원인 조사"), 600);
  });
  it('"전체" → 600', () => {
    assert.equal(estimate("explore", "", "전체 감사"), 600);
  });
  it('"싹다" → 600', () => {
    assert.equal(estimate("explore", "", "싹다 정리"), 600);
  });
  it('"리팩터" → 900', () => {
    assert.equal(estimate("explore", "", "모듈 리팩터"), 900);
  });
  it('"마이그레이션" → 900', () => {
    assert.equal(estimate("explore", "", "DB 마이그레이션"), 900);
  });
  it('"대규모" → 900', () => {
    assert.equal(estimate("explore", "", "대규모 변경"), 900);
  });
  it('"검증" → 180', () => {
    assert.equal(estimate("explore", "", "기능 검증"), 180);
  });
  it('"테스트" → 180', () => {
    assert.equal(estimate("explore", "", "통합 테스트"), 180);
  });
});

describe("estimate_expected_duration_sec — 영어 키워드 bump", () => {
  it('"deep" → 600', () => {
    assert.equal(estimate("explore", "", "deep investigation"), 600);
  });
  it('"research" → 600', () => {
    assert.equal(estimate("explore", "", "do research"), 600);
  });
  it('"analyze" → 600', () => {
    assert.equal(estimate("explore", "", "analyze output"), 600);
  });
  it('"refactor" → 900', () => {
    assert.equal(estimate("explore", "", "refactor module"), 900);
  });
  it('"migration" → 900', () => {
    assert.equal(estimate("explore", "", "data migration"), 900);
  });
  it('"test" → 180', () => {
    assert.equal(estimate("explore", "", "run test"), 180);
  });
  it('"mcp" → 120', () => {
    assert.equal(estimate("explore", "", "mcp probe"), 120);
  });
});

describe("estimate_expected_duration_sec — 키워드 조합 (최대값 우선)", () => {
  it('"분석 + 리팩터" → 900 (더 큰 값)', () => {
    assert.equal(estimate("explore", "", "분석과 리팩터"), 900);
  });
  it('"테스트 + 분석" → 600 (분석이 더 큼)', () => {
    assert.equal(estimate("explore", "", "테스트 분석"), 600);
  });
  it('"mcp + 테스트" → 180 (테스트가 더 큼)', () => {
    assert.equal(estimate("explore", "", "mcp 테스트"), 180);
  });
});

describe("estimate_expected_duration_sec — agent/profile/keyword 상호작용", () => {
  it("executor + implement + 리팩터 → 900", () => {
    assert.equal(estimate("executor", "implement", "리팩터 작업"), 900);
  });
  it("scientist + review + 테스트 → 900 (agent 기본 우선)", () => {
    assert.equal(estimate("scientist", "review", "테스트"), 900);
  });
  it("writer + minimal + 분석 → 600", () => {
    assert.equal(estimate("writer", "minimal", "문서 분석"), 600);
  });
});

describe("estimate_expected_duration_sec — 한국어 대소문자/경계", () => {
  it("프롬프트에 단어 일부 포함 시에도 매칭 (비경계)", () => {
    // ",리서치," "리서치는" 같은 조사 붙은 경우도 매칭 — substring 매칭이므로 OK
    assert.equal(estimate("explore", "", "리서치는 끝났다"), 600);
    assert.equal(estimate("explore", "", "리팩터링 완료"), 900);
  });
  it("빈 프롬프트 = agent 기본값", () => {
    assert.equal(estimate("explore", "", ""), 30);
  });
});
