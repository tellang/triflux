import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  evaluateVendorQuota,
  QUOTA_DEMOTE_OVER_PERCENT,
  QUOTA_EXHAUSTED_PERCENT,
  readQuotaSnapshot,
} from "../../scripts/lib/quota-snapshot.mjs";

const tempDirs = [];

function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), "tfx-quota-snapshot-"));
  tempDirs.push(root);
  const home = join(root, "home");
  const cacheDir = join(home, ".claude", "cache");
  const tmpDir = join(root, "tmp");
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  return {
    root,
    home,
    cacheDir,
    tmpDir,
    env: {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      CODEX_HOME: join(home, ".codex"),
      TFX_TMP: tmpDir,
    },
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("quota-snapshot: Claude / Codex / Antigravity 스냅샷 해석", () => {
  const NOW = Date.parse("2026-11-17T08:00:00Z");

  it("Claude: 5시간/주간 중 최댓값 선택, 리셋 경과 0% 보정, 계정 불일치 및 만료 캐시 복구를 처리한다", () => {
    const sb = makeSandbox();
    assert.equal(QUOTA_DEMOTE_OVER_PERCENT, 95);
    assert.equal(QUOTA_EXHAUSTED_PERCENT, 100);

    writeFileSync(
      join(sb.home, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "acc-live" } }),
    );
    writeFileSync(
      join(sb.cacheDir, "claude-usage-cache.json"),
      JSON.stringify({
        account: "acc-live",
        timestamp: NOW - 10_000,
        data: {
          fiveHourPercent: 97,
          fiveHourResetsAt: new Date(NOW + 3600_000).toISOString(),
          weeklyPercent: 62,
          weeklyResetsAt: new Date(NOW + 86400_000).toISOString(),
        },
      }),
    );

    let snap = readQuotaSnapshot({
      home: sb.home,
      tmpDir: sb.tmpDir,
      env: sb.env,
      now: NOW,
    });
    assert.equal(snap.claude.usedPercent, 97);
    assert.equal(snap.claude.status, "over_95");
    assert.equal(snap.claude.demote, true);
    assert.equal(snap.claude.exhausted, false);

    // 5시간 한도 리셋 시각 경과 시 0%로 보정되어 주간(62%)만 남음
    writeFileSync(
      join(sb.cacheDir, "claude-usage-cache.json"),
      JSON.stringify({
        account: "acc-live",
        timestamp: NOW - 10_000,
        data: {
          fiveHourPercent: 100,
          fiveHourResetsAt: new Date(NOW - 1000).toISOString(),
          weeklyPercent: 62,
          weeklyResetsAt: new Date(NOW + 86400_000).toISOString(),
        },
      }),
    );
    snap = readQuotaSnapshot({
      home: sb.home,
      tmpDir: sb.tmpDir,
      env: sb.env,
      now: NOW,
    });
    assert.equal(snap.claude.fiveHourPercent, 0);
    assert.equal(snap.claude.usedPercent, 62);
    assert.equal(snap.claude.status, "ok");

    // 계정 불일치 시 무시하고 stale 처리
    writeFileSync(
      join(sb.cacheDir, "claude-usage-cache.json"),
      JSON.stringify({
        account: "acc-other",
        timestamp: NOW,
        data: { weeklyPercent: 100 },
      }),
    );
    snap = readQuotaSnapshot({
      home: sb.home,
      tmpDir: sb.tmpDir,
      env: sb.env,
      now: NOW,
    });
    assert.equal(snap.claude.status, "unknown");
    assert.equal(snap.claude.stale, true);
    assert.equal(snap.claude.reason, "account_mismatch");

    // ResetsAt 없이 TTL(5분) 경과한 만료 캐시는 영구 잠금 방지를 위해 복구
    writeFileSync(
      join(sb.cacheDir, "claude-usage-cache.json"),
      JSON.stringify({
        account: "acc-live",
        timestamp: NOW - 600_000,
        data: { weeklyPercent: 100 },
      }),
    );
    snap = readQuotaSnapshot({
      home: sb.home,
      tmpDir: sb.tmpDir,
      env: sb.env,
      now: NOW,
    });
    assert.equal(snap.claude.status, "unknown");
    assert.equal(snap.claude.exhausted, false);
    assert.equal(snap.claude.reason, "stale_expired");
  });

  it("Codex: 숫자 timestamp, primary/secondary 버킷 정규화, 초 단위 resets_at 보정, owner 대조를 검증한다", () => {
    const sb = makeSandbox();
    const codexHome = join(sb.home, ".codex");
    mkdirSync(codexHome, { recursive: true });

    writeFileSync(
      join(sb.cacheDir, "codex-rate-limits-cache.json"),
      JSON.stringify({
        owner: `${codexHome}|acct-1`,
        timestamp: Math.floor((NOW - 30_000) / 1000),
        buckets: {
          codex: {
            primary: {
              window_minutes: 300,
              used_percent: 100,
              resets_at: Math.floor((NOW - 60_000) / 1000),
            },
            secondary: {
              window_minutes: 10080,
              used_percent: 96,
              resets_at: Math.floor((NOW + 7200_000) / 1000),
            },
          },
        },
      }),
    );

    let snap = readQuotaSnapshot({
      home: sb.home,
      tmpDir: sb.tmpDir,
      env: sb.env,
      now: NOW,
    });
    assert.equal(snap.codex.primaryPercent, 0);
    assert.equal(snap.codex.secondaryPercent, 96);
    assert.equal(snap.codex.usedPercent, 96);
    assert.equal(snap.codex.status, "over_95");

    // owner 불일치 시 무시
    writeFileSync(
      join(sb.cacheDir, "codex-rate-limits-cache.json"),
      JSON.stringify({
        owner: "/other/codex/home|acct-2",
        timestamp: NOW,
        buckets: {
          codex: {
            primary: {
              used_percent: 100,
              resets_at: Math.floor((NOW + 3600_000) / 1000),
            },
          },
        },
      }),
    );
    snap = readQuotaSnapshot({
      home: sb.home,
      tmpDir: sb.tmpDir,
      env: sb.env,
      now: NOW,
    });
    assert.equal(snap.codex.status, "unknown");
    assert.equal(snap.codex.reason, "owner_mismatch");
  });

  it("Antigravity: GCP projectQuota 모드와 개인 계정 버킷 가족별 매칭 및 쿨다운 우선순위를 검증한다", () => {
    const sb = makeSandbox();
    const agyDir = join(sb.home, ".gemini", "antigravity-cli");
    mkdirSync(agyDir, { recursive: true });

    // 1) 개인 계정 모드 + Keychain 인증(accountLabel: null) + 후보별 버킷 분리
    writeFileSync(
      join(sb.cacheDir, "antigravity-quota-cache.json"),
      JSON.stringify({
        accountLabel: null,
        timestamp: NOW,
        buckets: [
          {
            id: "gemini-4-carbon-high",
            name: "Gemini 4 Carbon (High)",
            remaining_fraction: 0,
            reset_time: new Date(NOW + 3600_000).toISOString(),
          },
          {
            id: "gemini-4-hydrogen-medium",
            name: "Gemini 4 Hydrogen (Medium)",
            remaining_fraction: 0.6,
            reset_time: new Date(NOW + 3600_000).toISOString(),
          },
          {
            id: "gemini-4-argon-medium",
            name: "Gemini 4 Argon (Medium)",
            remaining_fraction: 0.03,
            reset_time: new Date(NOW + 3600_000).toISOString(),
          },
        ],
      }),
    );

    let snap = readQuotaSnapshot({
      home: sb.home,
      tmpDir: sb.tmpDir,
      env: sb.env,
      now: NOW,
    });
    assert.equal(snap.antigravity.authKind, "account");

    const carbonEval = evaluateVendorQuota(
      snap,
      {
        cli: "antigravity",
        familyOrModel: "carbon",
        effort: "high",
        profile: "carbon_high",
      },
      { home: sb.home, env: sb.env },
    );
    assert.equal(carbonEval.status, "exhausted");
    assert.equal(carbonEval.usedPercent, 100);

    const hydrogenEval = evaluateVendorQuota(
      snap,
      {
        cli: "antigravity",
        familyOrModel: "hydrogen",
        effort: "medium",
        profile: "hydrogen",
      },
      { home: sb.home, env: sb.env },
    );
    assert.equal(hydrogenEval.status, "ok");
    assert.equal(hydrogenEval.usedPercent, 40);

    const argonEval = evaluateVendorQuota(
      snap,
      {
        cli: "antigravity",
        familyOrModel: "argon",
        effort: "medium",
        profile: "argon",
      },
      { home: sb.home, env: sb.env },
    );
    assert.equal(argonEval.status, "over_95");
    assert.equal(argonEval.usedPercent, 97);

    // 2) 런타임 쿨다운 마커는 캐시 여유분보다 우선하며 만료 후 복구됨
    const futureEpochSec = Math.floor((NOW + 1800_000) / 1000);
    writeFileSync(
      join(sb.tmpDir, "tfx-agy-quota-reset"),
      `${futureEpochSec}\n`,
    );
    snap = readQuotaSnapshot({
      home: sb.home,
      tmpDir: sb.tmpDir,
      env: sb.env,
      now: NOW,
    });
    assert.equal(snap.antigravity.cooldownActive, true);
    assert.equal(
      evaluateVendorQuota(
        snap,
        {
          cli: "antigravity",
          familyOrModel: "hydrogen",
          effort: "medium",
          profile: "hydrogen",
        },
        { home: sb.home, env: sb.env },
      ).status,
      "cooldown",
    );

    const pastEpochSec = Math.floor((NOW - 5000) / 1000);
    writeFileSync(join(sb.tmpDir, "tfx-agy-quota-reset"), `${pastEpochSec}\n`);
    snap = readQuotaSnapshot({
      home: sb.home,
      tmpDir: sb.tmpDir,
      env: sb.env,
      now: NOW,
    });
    assert.equal(snap.antigravity.cooldownActive, false);

    // 3) GCP 프로젝트 모드
    writeFileSync(
      join(agyDir, "settings.json"),
      JSON.stringify({
        gcp: { project: "example-prod", location: "us-central1" },
      }),
    );
    writeFileSync(
      join(sb.cacheDir, "antigravity-quota-cache.json"),
      JSON.stringify({
        accountLabel: "example-prod",
        location: "us-central1",
        timestamp: NOW,
        projectQuota: {
          usedPercent: 100,
          resetTime: new Date(NOW + 1200_000).toISOString(),
        },
      }),
    );
    snap = readQuotaSnapshot({
      home: sb.home,
      tmpDir: sb.tmpDir,
      env: sb.env,
      now: NOW,
    });
    assert.equal(snap.antigravity.authKind, "project");
    assert.equal(snap.antigravity.status, "exhausted");
    assert.equal(snap.antigravity.usedPercent, 100);
  });
});
