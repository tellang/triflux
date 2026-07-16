import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  matchesRepoScope,
  selectPrimaryMatch,
} from "../../scripts/keyword-detector.mjs";
import {
  compileRules,
  loadRules,
  matchRules,
  resolveConflicts,
} from "../../scripts/lib/keyword-rules.mjs";

const ROOT = process.cwd();
const RULES_PATH = join(ROOT, "hooks/keyword-rules.json");
const rules = loadRules(RULES_PATH);
const compiled = compileRules(rules);

function topId(text) {
  return resolveConflicts(matchRules(compiled, text))[0]?.id;
}

// root cause ① — 리뷰/분석/계획/테스트/리서치/클린업 동사군을 tfx-unified 에서
// 분리해 각 전용 스킬로 라우팅한다 (예전엔 tfx-unified 가 전부 삼켰다).
describe("keyword routing: 동사군 분리 (root cause ①)", () => {
  const cases = [
    ["리뷰해줘 이 코드", "tfx-review"],
    ["검토해줘", "tfx-review"],
    ["review this PR", "tfx-review"],
    ["분석해줘 구조", "tfx-analysis"],
    ["analyze this module", "tfx-analysis"],
    ["계획 세워줘", "tfx-plan"],
    ["설계해줘", "tfx-plan"],
    ["테스트 돌려봐", "tfx-qa"],
    ["검증해줘", "tfx-qa"],
    ["찾아봐 최신 정보", "tfx-research"],
    ["조사해줘", "tfx-research"],
    ["정리해줘 슬롭", "tfx-prune"],
    ["클린업 해줘", "tfx-prune"],
  ];
  for (const [text, expected] of cases) {
    it(`'${text}' → ${expected}`, () => {
      assert.equal(topId(text), expected);
    });
  }
});

describe("keyword routing: tfx-unified 는 구현 동사만 (root cause ①)", () => {
  for (const text of [
    "만들어줘 함수",
    "고쳐줘 버그",
    "implement this",
    "build it",
    "fix the bug",
  ]) {
    it(`'${text}' → tfx-unified`, () => {
      assert.equal(topId(text), "tfx-unified");
    });
  }
});

// root cause ② — 전용 규칙은 priority 1 + supersedes:['tfx-unified'] 로 명시
// 호출/복합 의도에서 generic router 가로채기를 억제한다.
describe("keyword routing: 전용 규칙이 tfx-unified 를 supersede (root cause ②)", () => {
  it("구현+리뷰 복합 → tfx-review 가 tfx-unified 를 supersede", () => {
    const resolved = resolveConflicts(
      matchRules(compiled, "만들어줘 그리고 검토해줘"),
    );
    assert.equal(resolved[0].id, "tfx-review");
    assert.equal(
      resolved.some((m) => m.id === "tfx-unified"),
      false,
    );
  });

  it("명시 슬래시 호출 '/tfx-plan' → tfx-plan (재라우팅 억제)", () => {
    assert.equal(topId("/tfx-plan 세워줘"), "tfx-plan");
  });

  for (const [text, id] of [
    ["tfx-review 해줘", "tfx-review"],
    ["tfx-find 해줘", "tfx-find"],
    ["tfx-prune 돌려", "tfx-prune"],
  ]) {
    it(`명시 토큰 '${text}' → ${id}`, () => {
      assert.equal(topId(text), id);
    });
  }

  it("전용 규칙은 priority 1 + supersedes:['tfx-unified']", () => {
    const dedicated = [
      "tfx-review",
      "tfx-analysis",
      "tfx-plan",
      "tfx-qa",
      "tfx-research",
      "tfx-find",
      "tfx-prune",
    ];
    for (const id of dedicated) {
      const rule = rules.find((x) => x.id === id);
      assert.ok(rule, `${id} 규칙이 존재해야 함`);
      assert.equal(rule.priority, 1, `${id} priority=1`);
      assert.ok(
        rule.supersedes.includes("tfx-unified"),
        `${id} 는 tfx-unified 를 supersede 해야 함`,
      );
    }
  });
});

// root cause ③ — tfx-ship 은 triflux npm 릴리즈 전용. repo 스코프 + 동사형만.
describe("keyword routing: tfx-ship repo 스코프 (root cause ③)", () => {
  const shipRule = rules.find((r) => r.id === "tfx-ship");

  it("tfx-ship 규칙에 repo_scope=['triflux'] + explicit", () => {
    assert.deepEqual(shipRule.repo_scope, ["triflux"]);
    assert.equal(shipRule.explicit, true);
  });

  it("전역 매칭(release/publish/맨 명사 배포) 은 제거됨", () => {
    const sources = shipRule.patterns.map((p) => p.source);
    assert.ok(
      !sources.some((s) => /release|publish/i.test(s)),
      "release/publish 전역 패턴이 없어야 함",
    );
    assert.ok(
      !sources.includes("배포(?!자|사|장|처)"),
      "맨 명사 배포 패턴이 없어야 함",
    );
  });

  it("matchesRepoScope 는 path segment 단위로 매칭한다", () => {
    assert.equal(
      matchesRepoScope("/Users/x/Projects/tools/triflux/scripts", ["triflux"]),
      true,
    );
    assert.equal(
      matchesRepoScope("/Users/x/triflux-ideas", ["triflux"]),
      false,
    );
    assert.equal(matchesRepoScope("/anything", []), true);
  });
});

// root cause ④ — resolvedMatches[0] 단일 승자 + 우선순위 역전 수정.
describe("keyword routing: 우선순위 역전 방지 (root cause ④)", () => {
  it("selectPrimaryMatch: explicit 종결 라우팅이 generic router 를 이긴다", () => {
    const resolved = [
      { id: "tfx-unified", priority: 2, explicit: false, skill: "tfx-auto" },
      { id: "tfx-ship", priority: 3, explicit: true, skill: "tfx-ship" },
    ];
    assert.equal(selectPrimaryMatch(resolved).id, "tfx-ship");
  });

  it("selectPrimaryMatch: 단일 매치는 그대로 선택", () => {
    assert.equal(
      selectPrimaryMatch([{ id: "tfx-unified", priority: 2 }]).id,
      "tfx-unified",
    );
  });

  it("selectPrimaryMatch: explicit 없으면 정렬 선두 유지 (MCP 라우트 영향 없음)", () => {
    const resolved = [
      { id: "tfx-unified", priority: 2, explicit: false },
      {
        id: "notion-route",
        priority: 10,
        explicit: false,
        mcp_route: "antigravity",
      },
    ];
    assert.equal(selectPrimaryMatch(resolved).id, "tfx-unified");
  });

  it("selectPrimaryMatch: 빈 배열은 null", () => {
    assert.equal(selectPrimaryMatch([]), null);
  });
});

describe("keyword routing: disabled 규칙 존중", () => {
  it("gstack-ship(disabled:true) 은 로드되지 않는다", () => {
    assert.equal(
      rules.some((r) => r.id === "gstack-ship"),
      false,
    );
  });
});
