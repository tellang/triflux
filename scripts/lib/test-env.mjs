// 테스트 실행 신호. node --test 자식과 test-lock 아래에서 켜진다.
export function isTestRun(env = process.env) {
  return (
    env.NODE_ENV === "test" ||
    env.TFX_TEST === "1" ||
    Boolean(
      env.TEST_LOCK_PID || env.NODE_TEST_CONTEXT || env.NODE_TEST_WORKER_ID,
    )
  );
}

// 테스트인데 홈을 임시 디렉터리로 돌렸다는 신호가 없으면 실제 홈에 쓰게 된다(#529).
// TRIFLUX_TEST_HOME 은 테스트가 직접 주고, TFX_TEST_HOME_ISOLATED 는 test-lock 이 준다.
export function writesRealHomeInTest(env = process.env) {
  return (
    isTestRun(env) &&
    !env.TRIFLUX_TEST_HOME &&
    env.TFX_TEST_HOME_ISOLATED !== "1"
  );
}
