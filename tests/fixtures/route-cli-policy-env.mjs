// tests/fixtures/route-cli-policy-env.mjs
// route 자식 프로세스가 머신 전역 CLI disable 정책을 상속하지 않게 고정한다.
//
// 왜 삭제가 아니라 "0" 고정인가:
// scripts/tfx-route.sh 는 env 가 비어 있을 때만 machine profile 값을 채운다
// (`[[ -n "${TFX_DISABLE_CODEX+x}" ]] || TFX_DISABLE_CODEX="$value"`).
// 이 머신의 ~/.config/triflux/machine-profile.env 에 TFX_DISABLE_CODEX=1 과
// TFX_DISABLE_ANTIGRAVITY=1 이 들어 있어서, 부모 셸 변수를 지우기만 하면
// 프로파일 파일이 다시 1 을 공급한다. env 를 "0" 으로 명시해야 두 경로를
// 모두 덮는다. 기존 격리 커밋(4aaf0897, f49ed3ac, e89c0bd4)도 같은 방식이다.
//
// disable 동작 자체를 검증하는 테스트는 bash 명령 문자열이나 overrides 로
// 자기 값을 넣으므로 이 기본값보다 우선한다.

export const ROUTE_CLI_POLICY_DEFAULTS = Object.freeze({
  TFX_DISABLE_ANTIGRAVITY: "0",
  TFX_DISABLE_CODEX: "0",
});

/**
 * base env 에 CLI disable 기본값을 얹는다. 호출자 overrides 가 항상 이긴다.
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @param {Record<string, string>} [overrides]
 */
export function routeCliPolicyEnv(baseEnv = process.env, overrides = {}) {
  return {
    ...baseEnv,
    ...ROUTE_CLI_POLICY_DEFAULTS,
    ...overrides,
  };
}
