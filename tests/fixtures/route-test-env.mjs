// tests/fixtures/route-test-env.mjs: tfx-route.sh 를 띄우는 테스트의 공용 env

import { ROUTE_CLI_POLICY_DEFAULTS } from "./route-cli-policy-env.mjs";

export function routeTestEnv(overrides = {}, baseEnv = process.env) {
  return {
    ...baseEnv,
    // 머신 전역 CLI disable 정책을 자식 route 프로세스가 물려받지 않게 한다.
    // overrides 뒤가 아니라 앞에 두므로 호출자가 자기 값으로 덮을 수 있다.
    ...ROUTE_CLI_POLICY_DEFAULTS,
    ...overrides,
  };
}
