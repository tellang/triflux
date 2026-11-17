import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { shiftCodexAgentProfile } from "../../scripts/lib/agent-route-policy.mjs";
import {
  ROLE_PRIORITY_TABLE,
  reconcileCandidatesWithJev,
  resolveRoleCandidates,
} from "../../scripts/lib/vendor-priority-policy.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BRIDGE_SCRIPT = resolve(PROJECT_ROOT, "hub", "bridge.mjs");

function cleanEnv(overrides = {}) {
  return {
    TFX_CLI_MODE: "auto",
    TFX_DISABLE_CODEX: "0",
    TFX_DISABLE_ANTIGRAVITY: "0",
    TFX_DISABLE_CLAUDE: "0",
    TFX_CODEX_OK: "1",
    TFX_ANTIGRAVITY_OK: "1",
    TFX_CLAUDE_OK: "1",
    TFX_NO_CLAUDE_NATIVE: "0",
    TFX_VERIFIER_OVERRIDE: "auto",
    ...overrides,
  };
}

function makeSnapshot({
  claude = 10,
  codex = 10,
  antigravity = 10,
  claudeCooldown = false,
  codexCooldown = false,
  agyCooldown = false,
} = {}) {
  const mk = (pct, cooldown) => ({
    status: cooldown
      ? "cooldown"
      : pct >= 100
        ? "exhausted"
        : pct > 95
          ? "over_95"
          : "ok",
    usedPercent: pct,
    percent: pct,
    cooldownActive: cooldown,
    exhausted: pct >= 100,
    demote: pct > 95 && pct < 100,
    stale: false,
    reason: cooldown ? "runtime_cooldown" : null,
  });
  return {
    now: Date.now(),
    claude: mk(claude, claudeCooldown),
    codex: mk(codex, codexCooldown),
    antigravity: mk(antigravity, agyCooldown),
  };
}

describe("vendor-priority-policy: 6개 역할군 후보 순서 및 규칙 검증", () => {
  it("6개 역할군 모든 등록 역할이 유효한 등급과 단일값 설정을 반환하고 ultra 중첩 강등을 지킨다", () => {
    const groupsSeen = new Set();
    for (const [role, spec] of Object.entries(ROLE_PRIORITY_TABLE)) {
      groupsSeen.add(spec.group);
      const res = resolveRoleCandidates({
        agent: role,
        env: cleanEnv(
          spec.crossVendorDefault ? { TFX_REVIEW_AUTHOR: "codex" } : {},
        ),
        available: { codex: true, antigravity: true, claude: true },
        quotaSnapshot: makeSnapshot(),
      });
      assert.ok(res.candidates.length >= 2, `${role} 후보가 2개 이상이어야 함`);
      for (const c of res.candidates) {
        assert.ok(["top", "high", "mid", "low"].includes(c.tier));
        assert.ok(c.timeoutSec > 0);
        assert.ok(typeof c.mcpHint === "string");
      }
    }
    assert.deepEqual([...groupsSeen].sort(), [
      "execution",
      "exploration",
      "judgment",
      "lead_communication",
      "verification",
      "writing_design",
    ]);

    // security-reviewer는 NO_LOWER로 등급 하향을 거부한다
    assert.equal(
      shiftCodexAgentProfile("security-reviewer", "lower"),
      "astra_xhigh",
    );

    // deep-executor / scientist-deep은 nested=true에서 ultra를 astra_max로 제한한다
    for (const ultraRole of ["deep-executor", "scientist-deep"]) {
      const nestedRes = resolveRoleCandidates({
        agent: ultraRole,
        nested: true,
        env: cleanEnv({ TFX_CODEX_PROFILE: "ultra" }),
        available: { codex: true, antigravity: true, claude: true },
        quotaSnapshot: makeSnapshot(),
      });
      const codexCand = nestedRes.candidates.find((c) => c.cli === "codex");
      assert.notEqual(codexCand.effort, "ultra");
    }
  });

  it("쿼터 <=95%는 유지하고 >95%(96%)는 우측 역순 1칸 후순위 이동하며 >=100%는 제외한다", () => {
    // 95% 정확히 도달 시 순서 유지 (executor: codex -> antigravity -> claude)
    const keep95 = resolveRoleCandidates({
      agent: "executor",
      env: cleanEnv(),
      available: { codex: true, antigravity: true, claude: true },
      quotaSnapshot: makeSnapshot({ codex: 95, antigravity: 20, claude: 20 }),
    });
    assert.deepEqual(
      keep95.candidates.map((c) => c.cli),
      ["codex", "antigravity", "claude"],
    );

    // 1순위 codex 96% -> 정확히 1칸만 밀려 [antigravity, codex, claude]
    const demoteFirst = resolveRoleCandidates({
      agent: "executor",
      env: cleanEnv(),
      available: { codex: true, antigravity: true, claude: true },
      quotaSnapshot: makeSnapshot({ codex: 96, antigravity: 20, claude: 20 }),
    });
    assert.deepEqual(
      demoteFirst.candidates.map((c) => c.cli),
      ["antigravity", "codex", "claude"],
    );
    assert.equal(demoteFirst.usageSwitch, true);

    // 복수 벤더(codex 96%, antigravity 97%) 우측 역순 1칸 이동:
    // 초기 [codex(96), agy(97), claude(20)] -> 우측부터 agy<->claude 교환 [codex(96), claude(20), agy(97)]
    // -> 그다음 codex<->claude 교환 [claude(20), codex(96), agy(97)] (codex가 2칸 밀리지 않고 1칸만 이동!)
    const demoteTwo = resolveRoleCandidates({
      agent: "executor",
      env: cleanEnv(),
      available: { codex: true, antigravity: true, claude: true },
      quotaSnapshot: makeSnapshot({ codex: 96, antigravity: 97, claude: 20 }),
    });
    assert.deepEqual(
      demoteTwo.candidates.map((c) => c.cli),
      ["claude", "codex", "antigravity"],
    );

    // 100% 도달 벤더는 하드 제외
    const exhausted = resolveRoleCandidates({
      agent: "executor",
      env: cleanEnv(),
      available: { codex: true, antigravity: true, claude: true },
      quotaSnapshot: makeSnapshot({ codex: 100, antigravity: 20, claude: 20 }),
    });
    assert.deepEqual(
      exhausted.candidates.map((c) => c.cli),
      ["antigravity", "claude"],
    );
    assert.equal(exhausted.excluded[0].reason, "quota_exhausted");
  });

  it("Jev 신뢰도 0.84 미적용 대 0.85 최대 1칸 인접 교환, decomposable:false 하향 차단, bridge judge-route 연동을 검증한다", () => {
    const base = resolveRoleCandidates({
      agent: "executor",
      env: cleanEnv(),
      available: { codex: true, antigravity: true, claude: true },
      quotaSnapshot: makeSnapshot(),
    }).candidates;

    // 0.84는 교환하지 않는다
    const lowConf = reconcileCandidatesWithJev(base, {
      confidence: 0.84,
      taskTrait: "visual_frontend",
      decomposable: true,
    });
    assert.equal(lowConf.adjusted, false);
    assert.deepEqual(
      lowConf.candidates.map((c) => c.cli),
      ["codex", "antigravity", "claude"],
    );

    // 0.85 + visual_frontend는 인접 1칸(codex <-> antigravity)만 교환한다
    const highConf = reconcileCandidatesWithJev(base, {
      confidence: 0.85,
      taskTrait: "visual_frontend",
      decomposable: true,
    });
    assert.equal(highConf.adjusted, true);
    assert.deepEqual(
      highConf.candidates.map((c) => c.cli),
      ["antigravity", "codex", "claude"],
    );

    // 3순위(index 2) 벤더를 recommendedCli로 지정해도 최대 1칸(index 2 -> index 1)만 오른다
    const stepOneOnly = reconcileCandidatesWithJev(base, {
      confidence: 0.95,
      recommendedCli: "claude",
      decomposable: true,
    });
    assert.deepEqual(
      stepOneOnly.candidates.map((c) => c.cli),
      ["codex", "claude", "antigravity"],
    );

    // decomposable: false 이면 fast_parallel_slice 하향성 교환을 차단한다
    const judgmentBase = resolveRoleCandidates({
      agent: "architect",
      env: cleanEnv(),
      available: { codex: true, antigravity: true, claude: true },
      quotaSnapshot: makeSnapshot(),
    }).candidates;
    const blockedSwap = reconcileCandidatesWithJev(judgmentBase, {
      confidence: 0.95,
      taskTrait: "fast_parallel_slice",
      decomposable: false,
    });
    assert.equal(blockedSwap.adjusted, false);
    assert.equal(blockedSwap.candidates[0].cli, "claude");

    // bridge.mjs judge-route --candidates-json 연동 검증 (Jev 비활성 기본 상태에서도 후보 정보 유지)
    const bridgeRun = spawnSync(
      process.execPath,
      [
        BRIDGE_SCRIPT,
        "judge-route",
        "--agent",
        "executor",
        "--cli-type",
        "codex",
        "--cli-mode",
        "auto",
        "--candidates-json",
        JSON.stringify(base),
        "--prompt",
        "UI 컴포넌트 레이아웃 개선",
      ],
      {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        env: { ...process.env, TFX_JEV: "0" },
      },
    );
    assert.equal(bridgeRun.status, 0, bridgeRun.stderr);
    const parsed = JSON.parse(bridgeRun.stdout);
    assert.equal(parsed.effectiveCandidate.cli, "codex");
  });

  it("일반 리뷰어는 작성 벤더 제외, top 작성 등급 승격, 타 벤더 전멸 시 동일 벤더 freshSessionRequired 폴백을 수행한다", () => {
    // codex 작성 코드 -> claude(opus), antigravity(hydrogen_high)
    const codexAuthored = resolveRoleCandidates({
      agent: "code-reviewer",
      env: cleanEnv({ TFX_REVIEW_AUTHOR: "codex" }),
      available: { codex: true, antigravity: true, claude: true },
      quotaSnapshot: makeSnapshot(),
    });
    assert.deepEqual(
      codexAuthored.candidates.map((c) => c.cli),
      ["claude", "antigravity"],
    );

    // TFX_REVIEW_AUTHOR_TIER=top 시 남은 후보가 top 등급(astra_xhigh, carbon_high)으로 승격됨
    const topAuthored = resolveRoleCandidates({
      agent: "code-reviewer",
      env: cleanEnv({
        TFX_REVIEW_AUTHOR: "claude",
        TFX_REVIEW_AUTHOR_TIER: "top",
      }),
      available: { codex: true, antigravity: true, claude: true },
      quotaSnapshot: makeSnapshot(),
    });
    assert.equal(topAuthored.candidates[0].cli, "codex");
    assert.equal(topAuthored.candidates[0].profile, "astra_xhigh");
    assert.equal(topAuthored.candidates[1].cli, "antigravity");
    assert.equal(topAuthored.candidates[1].profile, "carbon_high");

    // 타 벤더 2곳이 모두 비가용일 때만 동일 벤더 후보를 freshSessionRequired: true로 반환한다
    const sameVendorFallback = resolveRoleCandidates({
      agent: "code-reviewer",
      env: cleanEnv({ TFX_REVIEW_AUTHOR: "codex" }),
      available: { codex: true, antigravity: false, claude: false },
      quotaSnapshot: makeSnapshot(),
    });
    assert.equal(sameVendorFallback.candidates.length, 1);
    assert.equal(sameVendorFallback.candidates[0].cli, "codex");
    assert.equal(sameVendorFallback.candidates[0].freshSessionRequired, true);
    assert.equal(
      sameVendorFallback.candidates[0].selectionReason,
      "same_vendor_fresh_session",
    );

    // 세 벤더 모두 비가용이면 빈 배열 반환
    const allDead = resolveRoleCandidates({
      agent: "code-reviewer",
      env: cleanEnv({ TFX_REVIEW_AUTHOR: "codex" }),
      available: { codex: false, antigravity: false, claude: false },
      quotaSnapshot: makeSnapshot(),
    });
    assert.equal(allDead.candidates.length, 0);
  });
});
