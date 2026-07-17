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

// root cause ① 의 hook 계층 동사군 분리는 lane2-d 잠금(2026-07-17,
// tests/unit/lane2-d-routing-contract.test.mjs "locked prompt matrix")이 우선해
// 접었다 — hook 은 광역 동사를 tfx-unified 로 유지하고, 세분화는 D-트리(모델
// 계층)가 담당한다. 전용 규칙은 명시 토큰 전용으로 존재한다(root cause ② 블록).
describe("keyword routing: 광역 동사는 tfx-unified 유지 (lane2-d 잠금)", () => {
  const cases = [
    ["리뷰해줘 이 코드", "tfx-unified"],
    ["검토해줘", "tfx-unified"],
    ["review this PR", "tfx-unified"],
    ["분석해줘 구조", "tfx-unified"],
    ["analyze this module", "tfx-unified"],
    ["계획 세워줘", "tfx-unified"],
    ["설계해줘", "tfx-unified"],
    ["테스트 돌려봐", "tfx-unified"],
    ["검증해줘", "tfx-unified"],
    ["찾아봐 최신 정보", "tfx-unified"],
    ["조사해줘", "tfx-unified"],
    ["만들어줘 함수", "tfx-unified"],
    ["고쳐줘 버그", "tfx-unified"],
    ["implement this", "tfx-unified"],
    // H-결정(D8, 2026-07-17): 무수식 slop/cleanup 은 host ai-slop-cleaner 소유.
    ["정리해줘 슬롭", "host-ai-slop-cleaner"],
    ["클린업 해줘", "host-ai-slop-cleaner"],
  ];
  for (const [text, expected] of cases) {
    it(`'${text}' → ${expected}`, () => {
      assert.equal(topId(text), expected);
    });
  }
});

// root cause ② — 전용 규칙은 priority 1 + supersedes:['tfx-unified'] 로 명시
// 호출/복합 의도에서 generic router 가로채기를 억제한다.
describe("keyword routing: 전용 규칙이 tfx-unified 를 supersede (root cause ②)", () => {
  it("구현+명시토큰 복합 → tfx-review 가 tfx-unified 를 supersede", () => {
    const resolved = resolveConflicts(
      matchRules(compiled, "만들어줘 그리고 tfx-review 해줘"),
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

  it("영문 release/publish 전역 패턴은 제거, 배포/릴리즈는 repo_scope 로 가드", () => {
    const sources = shipRule.patterns.map((p) => p.source);
    assert.ok(
      !sources.some((s) => /release|publish/i.test(s)),
      "release/publish 전역 패턴이 없어야 함",
    );
    // lane2-d 잠금("배포 검증해줘" → tfx-ship)과의 조정: 맨 명사 배포 패턴은
    // 유지하되 repo_scope=["triflux"] 로 타 repo 하이재킹을 차단한다.
    assert.ok(
      sources.includes("배포(?!자|사|장|처)"),
      "배포 패턴은 유지 (repo_scope 가드)",
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
  it("disabled:true 규칙은 loadRules 가 제외한다 (fixture)", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "kw-rules-"));
    const fixture = join(dir, "rules.json");
    writeFileSync(
      fixture,
      JSON.stringify({
        rules: [
          {
            id: "enabled-rule",
            patterns: [{ source: "foo", flags: "i" }],
            skill: "x",
            priority: 1,
          },
          {
            id: "disabled-rule",
            patterns: [{ source: "bar", flags: "i" }],
            skill: "y",
            priority: 1,
            disabled: true,
          },
        ],
      }),
    );
    const loaded = loadRules(fixture);
    assert.deepEqual(
      loaded.map((r) => r.id),
      ["enabled-rule"],
    );
    rmSync(dir, { recursive: true, force: true });
  });

  // H-결정(151baa86, 2026-07-17): gstack-ship 재활성화 — 회귀 가드.
  it("gstack-ship 은 활성 상태다 (재활성화 결정 존중)", () => {
    assert.equal(
      rules.some((r) => r.id === "gstack-ship"),
      true,
    );
  });
});
