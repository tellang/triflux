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

// ADR-0021: hook 은 광역 동사 단독을 잡지 않는다. 60일 코퍼스에서 광역 동사
// 매칭이 오탐의 대부분(tfx-unified 63건 중 55건)이었다. 자연어 구현 요청은
// "대상 명사 + 구현·수정 동사" 형태만 suggest 로 잡고, 세분화는 D-트리(모델
// 계층)가 담당한다. 전용 규칙은 명시 토큰 전용으로 존재한다(root cause ② 블록).
describe("keyword routing: 광역 동사 단독은 매칭하지 않는다 (ADR-0021)", () => {
  for (const text of [
    "리뷰해줘 이 코드",
    "검토해줘",
    "review this PR",
    "분석해줘 구조",
    "analyze this module",
    "계획 세워줘",
    "설계해줘",
    "테스트 돌려봐",
    "검증해줘",
    "찾아봐 최신 정보",
    "조사해줘",
    "진행해",
    "계속해",
    "확인해줘",
    "정리해줘 슬롭",
    "클린업 해줘",
  ]) {
    it(`'${text}' → 매칭 없음`, () => {
      assert.equal(topId(text), undefined);
    });
  }
});

describe("keyword routing: 대상 명사 + 구현·수정 동사는 tfx-unified suggest", () => {
  for (const text of [
    "함수 만들어줘",
    "로그인 기능 구현해줘",
    "이 함수 버그 고쳐줘",
    "implement the parser",
    "fix the bug in auth",
  ]) {
    it(`'${text}' → tfx-unified (suggest)`, () => {
      const top = resolveConflicts(matchRules(compiled, text))[0];
      assert.equal(top?.id, "tfx-unified");
      assert.equal(top?.strength, "suggest");
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
    ["tfx-qa 돌려", "tfx-qa"],
  ]) {
    it(`명시 토큰 '${text}' → ${id}`, () => {
      assert.equal(topId(text), id);
    });
  }

  // 스킬 표면 축소(ADR-0020) 후 감사(ADR-0021): 사용 0회 토큰 규칙은 지우고,
  // tfx-qa 는 tfx-review 로 retarget, tfx-hub 토큰은 tfx-doctor 규칙에 합친다.
  it("tfx-qa 규칙은 tfx-review 로 retarget 된다", () => {
    assert.equal(rules.find((x) => x.id === "tfx-qa")?.skill, "tfx-review");
  });

  it("tfx hub 토큰은 tfx-doctor 규칙이 받는다", () => {
    assert.equal(topId("tfx hub 상태"), "tfx-doctor");
    assert.equal(topId("tfx-doctor 돌려"), "tfx-doctor");
  });

  for (const id of ["tfx-find", "tfx-analysis", "tfx-prune", "tfx-hub"]) {
    it(`${id} 규칙은 제거됐다`, () => {
      assert.equal(
        rules.some((x) => x.id === id),
        false,
      );
    });
  }

  it("전용 규칙은 priority 1 + supersedes:['tfx-unified']", () => {
    const dedicated = ["tfx-review", "tfx-plan", "tfx-qa", "tfx-research"];
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

  it("영문 release/publish 전역 패턴은 제거, 배포/릴리즈는 동사형만 + 질문 제외", () => {
    const sources = shipRule.patterns.map((p) => p.source);
    assert.ok(
      !sources.some((s) => /release|publish/i.test(s)),
      "release/publish 전역 패턴이 없어야 함",
    );
    // ADR-0021: 맨 명사 "배포"·"릴리즈" 패턴은 오탐 원인이라 동사형만 남긴다.
    assert.ok(!sources.includes("배포(?!자|사|장|처)"));
    assert.ok(!sources.includes("릴리[즈스]"));
    assert.equal(topId("릴리즈 해줘"), "tfx-ship");
    assert.equal(topId("배포 일정 공유"), undefined);
    assert.equal(topId("릴리즈 되나?"), undefined);
    assert.equal(topId("릴리즈 해도 되나?"), undefined);
    // 명시 토큰은 질문형이어도 MUST 로 남는다.
    const explicitAsk = resolveConflicts(
      matchRules(compiled, "tfx-ship 돌려도 되나?"),
    )[0];
    assert.equal(explicitAsk?.id, "tfx-ship");
    assert.equal(explicitAsk?.strength, "explicit");
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

// Codex 리뷰 P2 회귀 가드 2건 (PR #487)
describe("keyword routing: 명시 토큰이 자연어 제안을 이긴다 (P2-1)", () => {
  it("'tfx-review 로 AI 슬롭 봐줘' → 명시 토큰 tfx-review 선택", () => {
    const resolved = resolveConflicts(
      matchRules(compiled, "tfx-review 로 AI 슬롭 봐줘"),
    );
    // 정렬상 host-ai-slop-cleaner(suggest)가 앞서더라도 명시 토큰이 이겨야 한다.
    assert.ok(resolved.some((m) => m.id === "host-ai-slop-cleaner"));
    assert.equal(selectPrimaryMatch(resolved).id, "tfx-review");
  });

  it("selectPrimaryMatch: explicit 종결 규칙이라도 suggest 매칭이면 명시 토큰에 진다", () => {
    const resolved = [
      { id: "gstack-ship", priority: 1, strength: "suggest" },
      { id: "tfx-ship", priority: 1, explicit: true, strength: "suggest" },
      { id: "tfx-codex", priority: 3, strength: "explicit" },
    ];
    assert.equal(selectPrimaryMatch(resolved).id, "tfx-codex");
    assert.equal(
      selectPrimaryMatch(resolved.slice(0, 2)).id,
      "tfx-ship",
      "명시 토큰이 없으면 explicit 종결 규칙이 이긴다",
    );
  });

  it("전용 명시토큰 규칙은 전부 explicit:true", () => {
    for (const id of ["tfx-review", "tfx-plan", "tfx-qa", "tfx-research"]) {
      const rule = rules.find((x) => x.id === id);
      assert.equal(rule.explicit, true, `${id} explicit=true`);
      assert.equal(rule.strength, "explicit", `${id} strength=explicit`);
    }
  });
});

describe("keyword routing: direct-run 가드는 심링크 실행을 허용 (P2-2)", () => {
  it("심링크 경유 실행에서도 main() 이 구동돼 JSON 을 출력한다", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, symlinkSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "kw-symlink-"));
    const link = join(dir, "keyword-detector-link.mjs");
    symlinkSync(join(ROOT, "scripts/keyword-detector.mjs"), link);
    const out = execFileSync(process.execPath, [link], {
      input: JSON.stringify({
        prompt: "이 작업 tfx-auto 로 돌려줘",
        cwd: ROOT,
      }),
      encoding: "utf8",
    });
    const parsed = JSON.parse(out.trim().split("\n").at(-1));
    assert.equal(parsed.continue, true);
    assert.match(
      parsed.hookSpecificOutput?.additionalContext ?? "",
      /tfx-unified/,
    );
    rmSync(dir, { recursive: true, force: true });
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
