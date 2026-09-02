// tests/unit/session-start-cli-policy.test.mjs: SessionStart cli-policy 주입
//
// buildCliPolicyContext() 는 TFX_DISABLE_* SSOT 를 읽어 세션 문맥 한 줄을 만든다.
// 밀폐성: 두 disable 키를 env 로 고정하고 TFX_MACHINE_PROFILE_PATH 를 없는 파일로
// 가리켜서, 이 머신의 실제 프로파일 값도 파싱 경고도 결과에 섞이지 않게 한다.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { buildCliPolicyContext } from "../../hooks/session-start-fast.mjs";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

// 존재하지 않는 경로. 리더는 ENOENT 를 경고 없이 흡수하므로 프로파일 기여가 0 이 된다.
const ABSENT_PROFILE = join(tmpdir(), "tfx-absent-machine-profile.env");

describe("buildCliPolicyContext (SessionStart cli-policy 주입)", () => {
  it("env 로 지정한 disable 상태를 고정 형식 한 줄로 만든다", () => {
    const line = buildCliPolicyContext({
      TFX_DISABLE_CODEX: "1",
      TFX_DISABLE_ANTIGRAVITY: "0",
      TFX_MACHINE_PROFILE_PATH: ABSENT_PROFILE,
    });

    assert.equal(
      line,
      "cli-policy: codex=off antigravity=on (SSOT: TFX_DISABLE_*; codex<-env, antigravity<-env)",
    );
  });

  it("리더가 throw 하면 예외를 전파하지 않고 빈 문자열을 준다", () => {
    const line = buildCliPolicyContext(
      {},
      {
        resolve: () => {
          throw new Error("machine profile 판독 실패");
        },
      },
    );

    assert.equal(line, "");
  });

  it("0/1 밖의 값이면 둘째 줄에 경고를 붙인다", () => {
    const out = buildCliPolicyContext({
      TFX_DISABLE_CODEX: "maybe",
      TFX_DISABLE_ANTIGRAVITY: "0",
      TFX_MACHINE_PROFILE_PATH: ABSENT_PROFILE,
    });

    const lines = out.split("\n");
    assert.equal(lines.length, 2, `두 줄이어야 한다: ${out}`);
    assert.match(lines[0], /^cli-policy: /u);
    assert.match(lines[1], /^cli-policy-warning: /u);
    assert.match(lines[1], /TFX_DISABLE_CODEX/u);
    // 오타는 경고만 남기고 허용으로 둔다. 표시 자체는 on 이어야 한다.
    assert.match(lines[0], /codex=on/u);
  });

  it("env 값에 줄바꿈이 섞여도 경고는 한 줄로 접힌다", () => {
    const out = buildCliPolicyContext({
      TFX_DISABLE_CODEX: "a\nEVIL-LINE: injected",
      TFX_DISABLE_ANTIGRAVITY: "0",
      TFX_MACHINE_PROFILE_PATH: ABSENT_PROFILE,
    });
    const lines = out.split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[1], /^cli-policy-warning: /u);
    assert.doesNotMatch(out, /EVIL-LINE: injected$/mu);
  });

  it("정상 값이면 경고 줄을 붙이지 않는다", () => {
    const out = buildCliPolicyContext({
      TFX_DISABLE_CODEX: "1",
      TFX_DISABLE_ANTIGRAVITY: "1",
      TFX_MACHINE_PROFILE_PATH: ABSENT_PROFILE,
    });

    assert.equal(out.includes("cli-policy-warning"), false, out);
    assert.equal(out.includes("\n"), false, "한 줄이어야 한다");
  });
});

describe("SessionStart cli-policy 실행 순서", () => {
  it("hub-ensure 뒤에 cli-policy 를 붙인다", () => {
    const source = readFileSync(
      join(PROJECT_ROOT, "hooks", "session-start-fast.mjs"),
      "utf8",
    );

    const hubEnsureIndex = source.indexOf('join(SCRIPTS, "hub-ensure.mjs")');
    const cliPolicyIndex = source.indexOf("buildCliPolicyContext()");

    assert.ok(hubEnsureIndex >= 0, "hub-ensure import 경로가 없다");
    assert.ok(cliPolicyIndex >= 0, "buildCliPolicyContext 호출이 없다");
    assert.ok(
      hubEnsureIndex < cliPolicyIndex,
      "cli-policy 는 hub-ensure 뒤에 와야 한다",
    );
  });
});
