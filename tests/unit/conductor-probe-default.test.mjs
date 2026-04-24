// tests/unit/conductor-probe-default.test.mjs
// #165: TFX_PROBE_WRITE_STATE default off → on 전환 shape 검증.
// conductor.mjs 의 health-probe 생성 라인이 "default on, opt-out = 0" 형태인지 확인.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

describe("#165 conductor probe writeStateFile default", () => {
  it("conductor.mjs 는 TFX_PROBE_WRITE_STATE 가 '0' 이 아닐 때 writeStateFile=true 여야 한다", () => {
    const src = readFileSync(
      path.join(REPO_ROOT, "hub/team/conductor.mjs"),
      "utf8",
    );
    // default on: 조건은 `!== "0"` (명시적 off 만 opt-out)
    assert.match(
      src,
      /writeStateFile[^\n]*process\.env\.TFX_PROBE_WRITE_STATE\s*!==\s*"0"/,
      "conductor 의 probe writeStateFile default 는 `!== '0'` 패턴이어야 함 (PR #165)",
    );
    // 금지: 이전 `=== "1"` 패턴 (default off) 은 더 이상 존재하면 안 됨.
    assert.doesNotMatch(
      src,
      /writeStateFile[^\n]*process\.env\.TFX_PROBE_WRITE_STATE\s*===\s*"1"/,
      "PR #160 의 default off 패턴이 남아있으면 안 됨",
    );
  });

  it("packages 미러 (triflux, remote) 도 동일 패턴을 따라야 한다", () => {
    const triflux = readFileSync(
      path.join(REPO_ROOT, "packages/triflux/hub/team/conductor.mjs"),
      "utf8",
    );
    const remote = readFileSync(
      path.join(REPO_ROOT, "packages/remote/hub/team/conductor.mjs"),
      "utf8",
    );
    for (const [name, src] of [
      ["triflux", triflux],
      ["remote", remote],
    ]) {
      assert.match(
        src,
        /writeStateFile[^\n]*process\.env\.TFX_PROBE_WRITE_STATE\s*!==\s*"0"/,
        `${name} mirror 의 writeStateFile default 가 drift 됨`,
      );
    }
  });
});
