// tests/unit/conductor-probe-l2-default.test.mjs
// #168 P3: conductor 가 createHealthProbe 호출 시 enableL2 default on +
// checkMcp 주입 + TFX_PROBE_L2=0 opt-out shape 를 가지는지 소스 레벨 검증.
// (런타임 shape 검증은 health-probe.test.mjs 쪽이 담당.)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

describe("#168 conductor probe L2 default (hub health checker wiring)", () => {
  it("conductor.mjs imports createHubHealthChecker", () => {
    const src = readFileSync(
      path.join(REPO_ROOT, "hub/team/conductor.mjs"),
      "utf8",
    );
    assert.match(
      src,
      /import\s*\{\s*createHubHealthChecker\s*\}\s*from\s*["']\.\/check-mcp-hub\.mjs["']/,
      "conductor 가 check-mcp-hub.mjs 의 createHubHealthChecker 를 import 해야 함",
    );
  });

  it("enableL2 default = `!== '0'` (TFX_PROBE_L2 opt-out 패턴)", () => {
    const src = readFileSync(
      path.join(REPO_ROOT, "hub/team/conductor.mjs"),
      "utf8",
    );
    assert.match(
      src,
      /enableL2[^\n]*process\.env\.TFX_PROBE_L2\s*!==\s*"0"/,
      "conductor 의 enableL2 default 는 `!== '0'` opt-out 패턴이어야 함 (#168)",
    );
  });

  it("checkMcp 주입: probeOpts.checkMcp 우선, 미지정 시 createHubHealthChecker 기본", () => {
    const src = readFileSync(
      path.join(REPO_ROOT, "hub/team/conductor.mjs"),
      "utf8",
    );
    assert.match(
      src,
      /checkMcp:\s*\n?\s*probeOpts\.checkMcp\s*\|\|/,
      "probeOpts.checkMcp 가 우선 override 가능해야 함",
    );
    assert.match(
      src,
      /createHubHealthChecker\(\s*\{\s*hubUrl:\s*process\.env\.TFX_HUB_URL\s*\}\s*\)/,
      "default 는 TFX_HUB_URL 기반 createHubHealthChecker 여야 함",
    );
    assert.match(
      src,
      /process\.env\.TFX_PROBE_L2\s*===\s*"0"\s*\n?\s*\?\s*undefined/,
      "TFX_PROBE_L2=0 이면 checkMcp=undefined 로 wiring 건너뛰어야 함",
    );
  });

  it("packages 미러 (triflux, remote) 도 동일 패턴", () => {
    for (const mirror of [
      "packages/triflux/hub/team/conductor.mjs",
      "packages/remote/hub/team/conductor.mjs",
    ]) {
      const src = readFileSync(path.join(REPO_ROOT, mirror), "utf8");
      assert.match(
        src,
        /enableL2[^\n]*process\.env\.TFX_PROBE_L2\s*!==\s*"0"/,
        `${mirror} mirror 의 enableL2 default wiring drift`,
      );
      assert.match(
        src,
        /createHubHealthChecker/,
        `${mirror} mirror 가 createHubHealthChecker 를 쓰지 않음`,
      );
    }
  });
});
