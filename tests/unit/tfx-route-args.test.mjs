// tests/unit/tfx-route-args.test.mjs
// Phase 3 Step B — tfx-route-args 파서 계약 검증.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_OPTIONS,
  parseArgs,
  VALID_VALUES,
} from "../../hub/lib/tfx-route-args.mjs";

describe("tfx-route-args — parseArgs", () => {
  describe("기본값 + task 추출", () => {
    it("플래그 없으면 DEFAULT_OPTIONS + task 전체", () => {
      const r = parseArgs("리팩터링하고 테스트 추가");
      assert.equal(r.cli, DEFAULT_OPTIONS.cli);
      assert.equal(r.mode, DEFAULT_OPTIONS.mode);
      assert.equal(r.parallel, DEFAULT_OPTIONS.parallel);
      assert.equal(r.retry, DEFAULT_OPTIONS.retry);
      assert.equal(r.isolation, DEFAULT_OPTIONS.isolation);
      assert.equal(r.lead, DEFAULT_OPTIONS.lead);
      assert.equal(r.noClaudeNative, false);
      assert.equal(r.maxIterations, 0);
      assert.equal(r.task, "리팩터링하고 테스트 추가");
      assert.deepEqual(r.warnings, []);
    });

    it("따옴표 안 토큰은 유지, 바깥 공백으로 분리", () => {
      const r = parseArgs(`"JWT 인증" --cli codex`);
      assert.equal(r.cli, "codex");
      assert.equal(r.task, "JWT 인증");
    });

    it("배열 입력도 동일하게 처리", () => {
      const r = parseArgs(["--mode", "deep", "리팩터링"]);
      assert.equal(r.mode, "deep");
      assert.equal(r.task, "리팩터링");
    });
  });

  describe("Phase 3 신규 — --lead / --no-claude-native", () => {
    it("--cli codex --no-claude-native 조합 (tfx-auto-codex 등가)", () => {
      const r = parseArgs("JWT 리팩터링 --cli codex --lead codex --no-claude-native");
      assert.equal(r.cli, "codex");
      assert.equal(r.lead, "codex");
      assert.equal(r.noClaudeNative, true);
      assert.equal(r.task, "JWT 리팩터링");
      assert.deepEqual(r.warnings, []);
    });

    it("--lead 기본값은 claude, --no-claude-native 기본값은 false", () => {
      const r = parseArgs("work");
      assert.equal(r.lead, "claude");
      assert.equal(r.noClaudeNative, false);
    });

    it("--lead=codex (= 문법) 도 허용", () => {
      const r = parseArgs("work --lead=codex");
      assert.equal(r.lead, "codex");
    });
  });

  describe("Phase 3 신규 — --retry ralph / auto-escalate + --max-iterations", () => {
    it("--retry ralph --max-iterations 10 정상 파싱", () => {
      const r = parseArgs("끝까지 --retry ralph --max-iterations 10");
      assert.equal(r.retry, "ralph");
      assert.equal(r.maxIterations, 10);
      assert.equal(r.task, "끝까지");
    });

    it("--retry auto-escalate 는 기본값 maxIterations=0 유지 (unlimited)", () => {
      const r = parseArgs("승격 --retry auto-escalate");
      assert.equal(r.retry, "auto-escalate");
      assert.equal(r.maxIterations, 0);
    });

    it("--max-iterations 음수/NaN 은 warning + 기본값 유지", () => {
      const r = parseArgs("work --retry ralph --max-iterations -3");
      assert.equal(r.maxIterations, 0);
      assert.ok(
        r.warnings.some((w) => w.includes("invalid --max-iterations=-3")),
      );
    });

    it("VALID_VALUES.retry 는 0/1/ralph/auto-escalate 4개", () => {
      assert.deepEqual(
        [...VALID_VALUES.retry].sort(),
        ["0", "1", "auto-escalate", "ralph"],
      );
    });
  });

  describe("validation — 조합 규칙", () => {
    it("--parallel 1 + --isolation worktree → warning + isolation 강제 none", () => {
      const r = parseArgs("work --parallel 1 --isolation worktree");
      assert.equal(r.isolation, "none");
      assert.ok(
        r.warnings.some((w) => w.includes("--isolation worktree requires")),
      );
    });

    it("--remote host + --parallel 1 → warning (remote 무시)", () => {
      const r = parseArgs("work --remote host1 --parallel 1");
      assert.ok(
        r.warnings.some((w) => w.includes("--remote host1 ignored")),
      );
    });

    it("--parallel swarm + --remote host 는 warning 없음", () => {
      const r = parseArgs("work --parallel swarm --remote host1");
      assert.deepEqual(r.warnings, []);
    });

    it("--cli 잘못된 값은 warning", () => {
      const r = parseArgs("work --cli bogus");
      assert.ok(r.warnings.some((w) => w.includes("invalid --cli=bogus")));
    });

    it("unknown flag 는 warning + task 에 포함되지 않음", () => {
      const r = parseArgs("work --unknown-flag extra text");
      assert.ok(r.warnings.some((w) => w.includes("unknown flag: --unknown-flag")));
      assert.equal(r.task, "work extra text");
    });

    it("값 빠진 플래그는 warning", () => {
      const r = parseArgs(["--cli"]);
      assert.ok(r.warnings.some((w) => w.includes("--cli needs a value")));
    });
  });
});
