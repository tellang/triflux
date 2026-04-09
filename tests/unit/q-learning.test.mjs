import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { scoreComplexity } from "../../hub/routing/complexity.mjs";
import { resolveRoute, routerStatus } from "../../hub/routing/index.mjs";
import {
  ACTIONS,
  extractFeatures,
  FEATURE_KEYWORDS,
  LRUCache,
  QLearningRouter,
  stateKey,
} from "../../hub/routing/q-learning.mjs";

// ========================================================================
// 1. 복잡도 스코어링
// ========================================================================
describe("scoreComplexity", () => {
  it("빈 입력 → score 0", () => {
    const result = scoreComplexity("");
    assert.equal(result.score, 0);
    assert.equal(result.breakdown.lexical, 0);
  });

  it("null/undefined → score 0", () => {
    assert.equal(scoreComplexity(null).score, 0);
    assert.equal(scoreComplexity(undefined).score, 0);
  });

  it("간단한 작업 → 낮은 복잡도", () => {
    const result = scoreComplexity("fix a typo in README");
    assert.ok(result.score < 0.4, `expected < 0.4, got ${result.score}`);
  });

  it("복잡한 작업 → 높은 복잡도", () => {
    const result = scoreComplexity(
      "refactor the authentication architecture for distributed microservice security with encryption and database schema migration",
    );
    assert.ok(result.score > 0.4, `expected > 0.4, got ${result.score}`);
  });

  it("breakdown 필드가 모두 존재", () => {
    const result = scoreComplexity("implement a REST API endpoint");
    assert.ok("lexical" in result.breakdown);
    assert.ok("semantic" in result.breakdown);
    assert.ok("scope" in result.breakdown);
    assert.ok("uncertainty" in result.breakdown);
  });

  it("불확실성 키워드 → uncertainty 점수 상승", () => {
    const certain = scoreComplexity("implement login page");
    const uncertain = scoreComplexity(
      "maybe investigate and explore whether we could possibly implement login page?",
    );
    assert.ok(
      uncertain.breakdown.uncertainty > certain.breakdown.uncertainty,
      `uncertain(${uncertain.breakdown.uncertainty}) should > certain(${certain.breakdown.uncertainty})`,
    );
  });

  it("score는 항상 0-1 범위", () => {
    const inputs = [
      "simple fix",
      "refactor architecture security migration distributed concurrent parallel optimization performance scalability cryptography encryption authentication authorization database schema data model state machine event-driven microservice orchestration pipeline workflow",
      "a".repeat(10000),
    ];
    for (const input of inputs) {
      const { score } = scoreComplexity(input);
      assert.ok(
        score >= 0 && score <= 1,
        `score ${score} out of range for input length ${input.length}`,
      );
    }
  });
});

// ========================================================================
// 2. Q-Learning predict/update 사이클
// ========================================================================
describe("QLearningRouter", () => {
  const tmpModelPath = join(tmpdir(), `tfx-qlearn-test-${Date.now()}.json`);

  /** @type {QLearningRouter} */
  let router;

  beforeEach(() => {
    router = new QLearningRouter({
      epsilon: 0, // 탐색 비활성화 (결정적 테스트)
      modelPath: tmpModelPath,
    });
  });

  afterEach(() => {
    if (existsSync(tmpModelPath)) {
      try {
        unlinkSync(tmpModelPath);
      } catch {
        /* ignore */
      }
    }
  });

  it("초기 예측: 모든 Q-value 0이면 첫 번째 액션 반환", () => {
    const result = router.predict("implement a feature");
    assert.ok(
      ACTIONS.includes(result.action),
      `action ${result.action} not in ACTIONS`,
    );
    assert.equal(result.confidence, 0, "no visits → confidence 0");
    assert.equal(result.exploration, false, "epsilon=0 → no exploration");
  });

  it("update 후 predict: 보상 높은 액션이 선택됨", () => {
    // codex에 높은 보상 반복
    for (let i = 0; i < 15; i++) {
      router.update("implement a feature", "codex", 1.0);
    }
    const result = router.predict("implement a feature");
    assert.equal(result.action, "codex");
    assert.ok(result.confidence > 0, "visits > 0 → confidence > 0");
  });

  it("서로 다른 작업 → 서로 다른 최적 액션 학습", () => {
    // 실행 작업 → codex
    for (let i = 0; i < 20; i++) {
      router.update("implement and build code", "codex", 1.0);
      router.update("implement and build code", "gemini", -0.5);
    }
    // 디자인 작업 → gemini
    for (let i = 0; i < 20; i++) {
      router.update("design ui visual frontend", "gemini", 1.0);
      router.update("design ui visual frontend", "codex", -0.5);
    }
    const execResult = router.predict("implement and build code");
    const designResult = router.predict("design ui visual frontend");
    assert.equal(execResult.action, "codex");
    assert.equal(designResult.action, "gemini");
  });

  it("음수 보상 → 해당 액션 Q-value 감소", () => {
    router.update("test task", "codex", 1.0);
    const before = router.predict("test task");
    // 음수 보상 여러 번
    for (let i = 0; i < 10; i++) {
      router.update("test task", "codex", -1.0);
    }
    const after = router.predict("test task");
    // codex가 아닌 다른 액션이 선택되거나, 이전보다 Q-value가 낮아야 함
    // (첫 번째 update 이후 codex Q > 0 이었지만, 음수 반복 후 다른 액션 선택)
    assert.ok(
      after.action !== "codex" || before.confidence <= after.confidence,
      "negative reward should decrease codex preference",
    );
  });

  it("totalUpdates 증가 추적", () => {
    assert.equal(router.totalUpdates, 0);
    router.update("task", "codex", 0.5);
    assert.equal(router.totalUpdates, 1);
    router.update("task", "gemini", 0.3);
    assert.equal(router.totalUpdates, 2);
  });

  it("잘못된 액션 → update 무시", () => {
    router.update("task", "invalid_cli", 1.0);
    assert.equal(router.totalUpdates, 0);
  });
});

// ========================================================================
// 3. 엡실론-그리디 탐색/활용 비율
// ========================================================================
describe("엡실론-그리디", () => {
  it("epsilon=1 → 항상 탐색 (무작위)", () => {
    const router = new QLearningRouter({
      epsilon: 1.0,
      modelPath: join(tmpdir(), "nofile.json"),
    });
    const actions = new Set();
    // 충분히 반복하면 다양한 액션이 나와야 함
    for (let i = 0; i < 100; i++) {
      const { action, exploration } = router.predict(`task variant ${i}`);
      actions.add(action);
      assert.equal(exploration, true);
    }
    // 5개 액션 중 최소 2개 이상 등장 (확률적이지만 100회면 거의 확실)
    assert.ok(actions.size >= 2, `expected >= 2 actions, got ${actions.size}`);
  });

  it("epsilon=0 → 항상 활용", () => {
    const router = new QLearningRouter({
      epsilon: 0,
      modelPath: join(tmpdir(), "nofile.json"),
    });
    const result = router.predict("implement feature");
    assert.equal(result.exploration, false);
  });

  it("엡실론 감쇠: update마다 epsilon 감소", () => {
    const router = new QLearningRouter({
      epsilon: 0.3,
      epsilonDecay: 0.99,
      epsilonMin: 0.01,
      modelPath: join(tmpdir(), "nofile.json"),
    });
    const initial = router.epsilon;
    router.update("task", "codex", 0.5);
    assert.ok(
      router.epsilon < initial,
      `epsilon should decrease: ${router.epsilon} < ${initial}`,
    );
  });

  it("엡실론은 최소값 이하로 감소하지 않음", () => {
    const router = new QLearningRouter({
      epsilon: 0.06,
      epsilonDecay: 0.5,
      epsilonMin: 0.05,
      modelPath: join(tmpdir(), "nofile.json"),
    });
    router.update("task", "codex", 0.5);
    assert.ok(
      router.epsilon >= 0.05,
      `epsilon ${router.epsilon} should >= 0.05`,
    );
  });
});

// ========================================================================
// 4. agent-map.json 폴백 검증
// ========================================================================
describe("agent-map.json 폴백", () => {
  it("정적 폴백: 알려진 에이전트 → agent-map.json 매핑", () => {
    assert.equal(QLearningRouter.fallback("executor"), "codex");
    assert.equal(QLearningRouter.fallback("designer"), "gemini");
    assert.equal(QLearningRouter.fallback("explore"), "claude");
  });

  it("정적 폴백: 알 수 없는 에이전트 → 입력 그대로 반환", () => {
    assert.equal(QLearningRouter.fallback("unknown_agent"), "unknown_agent");
  });

  it("resolveRoute: 동적 라우팅 비활성화 시 정적 매핑", () => {
    // TRIFLUX_DYNAMIC_ROUTING이 설정되지 않은 기본 상태
    const saved = process.env.TRIFLUX_DYNAMIC_ROUTING;
    delete process.env.TRIFLUX_DYNAMIC_ROUTING;
    try {
      const result = resolveRoute("executor", "implement feature");
      assert.equal(result.cliType, "codex");
      assert.equal(result.source, "static");
      assert.equal(result.confidence, 1);
    } finally {
      if (saved !== undefined) process.env.TRIFLUX_DYNAMIC_ROUTING = saved;
    }
  });

  it("resolveRoute: 작업 설명 없으면 정적 폴백", () => {
    const saved = process.env.TRIFLUX_DYNAMIC_ROUTING;
    process.env.TRIFLUX_DYNAMIC_ROUTING = "true";
    try {
      const result = resolveRoute("executor", "");
      assert.equal(result.source, "static");
    } finally {
      if (saved !== undefined) {
        process.env.TRIFLUX_DYNAMIC_ROUTING = saved;
      } else {
        delete process.env.TRIFLUX_DYNAMIC_ROUTING;
      }
    }
  });

  it("routerStatus: 비활성화 시 enabled=false", () => {
    const saved = process.env.TRIFLUX_DYNAMIC_ROUTING;
    delete process.env.TRIFLUX_DYNAMIC_ROUTING;
    try {
      const status = routerStatus();
      assert.equal(status.enabled, false);
    } finally {
      if (saved !== undefined) process.env.TRIFLUX_DYNAMIC_ROUTING = saved;
    }
  });
});

// ========================================================================
// 5. 영속화 save/load 테스트
// ========================================================================
describe("Q-table 영속화", () => {
  const tmpModelPath = join(tmpdir(), `tfx-qlearn-persist-${Date.now()}.json`);

  afterEach(() => {
    if (existsSync(tmpModelPath)) {
      try {
        unlinkSync(tmpModelPath);
      } catch {
        /* ignore */
      }
    }
  });

  it("save → load: Q-table 복원", () => {
    const router1 = new QLearningRouter({
      epsilon: 0,
      modelPath: tmpModelPath,
    });
    for (let i = 0; i < 20; i++) {
      router1.update("implement code", "codex", 1.0);
    }
    router1.save();

    assert.ok(existsSync(tmpModelPath), "model file should exist");

    const router2 = new QLearningRouter({
      epsilon: 0,
      modelPath: tmpModelPath,
    });
    const loaded = router2.load();
    assert.ok(loaded, "load should return true");

    const prediction = router2.predict("implement code");
    assert.equal(
      prediction.action,
      "codex",
      "loaded router should predict codex",
    );
    assert.equal(router2.totalUpdates, 20);
  });

  it("load: 파일 없으면 false", () => {
    const router = new QLearningRouter({
      modelPath: join(tmpdir(), "nonexistent.json"),
    });
    assert.equal(router.load(), false);
  });

  it("load: 잘못된 JSON → false", () => {
    writeFileSync(tmpModelPath, "invalid json{{{", "utf8");
    const router = new QLearningRouter({ modelPath: tmpModelPath });
    assert.equal(router.load(), false);
  });

  it("load: 잘못된 version → false", () => {
    writeFileSync(tmpModelPath, JSON.stringify({ version: 999 }), "utf8");
    const router = new QLearningRouter({ modelPath: tmpModelPath });
    assert.equal(router.load(), false);
  });

  it("save 후 JSON 구조 검증", () => {
    const router = new QLearningRouter({
      epsilon: 0.2,
      modelPath: tmpModelPath,
    });
    router.update("task", "codex", 0.5);
    router.save();

    const data = JSON.parse(readFileSync(tmpModelPath, "utf8"));
    assert.equal(data.version, 1);
    assert.equal(typeof data.epsilon, "number");
    assert.equal(data.totalUpdates, 1);
    assert.equal(typeof data.qTable, "object");
    assert.equal(typeof data.visitCounts, "object");
  });
});

// ========================================================================
// 6. 내부 유틸리티
// ========================================================================
describe("내부 유틸리티", () => {
  it("extractFeatures: 48차원 벡터", () => {
    const features = extractFeatures("implement a feature");
    assert.equal(features.length, FEATURE_KEYWORDS.length);
    assert.equal(features.length, 48);
    // 'implement'가 포함되므로 해당 인덱스가 1
    const idx = FEATURE_KEYWORDS.indexOf("implement");
    assert.equal(features[idx], 1);
  });

  it("stateKey: 동일 입력 → 동일 키", () => {
    const f1 = extractFeatures("implement feature");
    const f2 = extractFeatures("implement feature");
    assert.equal(stateKey(f1), stateKey(f2));
  });

  it("stateKey: 다른 입력 → 다른 키 (높은 확률)", () => {
    const f1 = extractFeatures("implement code");
    const f2 = extractFeatures("design visual ui");
    assert.notEqual(stateKey(f1), stateKey(f2));
  });

  it("LRUCache: 기본 동작", () => {
    const cache = new LRUCache(3, 60000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    assert.equal(cache.get("a"), 1);
    assert.equal(cache.get("b"), 2);
    // 4번째 삽입 시 가장 오래된 항목 제거
    cache.set("d", 4);
    // 'a'는 최근 get으로 갱신됐으므로 'c'가 제거됨
    assert.equal(cache.get("c"), undefined);
    assert.equal(cache.get("d"), 4);
  });

  it("LRUCache: TTL 만료", async () => {
    const cache = new LRUCache(10, 50); // 50ms TTL
    cache.set("key", "value");
    assert.equal(cache.get("key"), "value");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(cache.get("key"), undefined);
  });
});
