// tests/unit/build-worker-prompt.test.mjs — #125 prompt appendix injection

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  buildLeaseScopedAcceptanceAppendix,
  buildWorkerPrompt,
  COMPLETION_PROTOCOL_APPENDIX,
} from "../../hub/team/build-worker-prompt.mjs";
import {
  SENTINEL_BEGIN,
  SENTINEL_END,
} from "../../hub/team/sentinel-capture.mjs";

test("appendix 는 두 sentinel 마커를 명시", () => {
  assert.ok(COMPLETION_PROTOCOL_APPENDIX.includes(SENTINEL_BEGIN));
  assert.ok(COMPLETION_PROTOCOL_APPENDIX.includes(SENTINEL_END));
});

test("appendix 는 자동 삽입 표식 + PRD 작성자 안내 포함", () => {
  assert.ok(COMPLETION_PROTOCOL_APPENDIX.includes("자동 삽입됨"));
  assert.ok(
    COMPLETION_PROTOCOL_APPENDIX.includes(
      "PRD 작성자는 이 섹션을 수정하지 마세요",
    ),
  );
});

test("buildWorkerPrompt — PRD body 뒤에 appendix 부착", () => {
  const result = buildWorkerPrompt("# PRD body\n## 목표\n무언가");
  assert.ok(result.startsWith("# PRD body"));
  assert.ok(result.includes("Lease-scoped Acceptance / Lint Guard"));
  assert.ok(
    result.includes(
      "위 PRD 본문의 모든 제약과 acceptance 기준은 이 appendix 이후에도 그대로 유효하다.",
    ),
  );
  assert.ok(result.includes(SENTINEL_BEGIN));
  assert.ok(result.includes(SENTINEL_END));
  // appendices 는 PRD 본문 뒤에 위치해야 함.
  const beginIdx = result.indexOf(SENTINEL_BEGIN);
  const bodyEnd = result.indexOf("무언가") + "무언가".length;
  assert.ok(beginIdx > bodyEnd);
});

test("buildWorkerPrompt — lease 파일로 acceptance/lint 범위를 좁힘", () => {
  const result = buildWorkerPrompt("do shard work", {
    leaseFiles: ["hub/team/build-worker-prompt.mjs", "tests/unit/foo.test.mjs"],
  });

  assert.ok(result.includes("- hub/team/build-worker-prompt.mjs"));
  assert.ok(result.includes("- tests/unit/foo.test.mjs"));
  assert.ok(result.includes("npx biome check <changed-files-or-lease-files>"));
  assert.ok(result.includes("npm run lint:fix"));
  assert.ok(result.includes("Pre-existing lint drift outside the lease"));
});

test("buildWorkerPrompt — worktreePath 로 lease/상대경로 기준 루트를 고정", () => {
  const result = buildWorkerPrompt("do shard work", {
    leaseFiles: ["hub/team/build-worker-prompt.mjs"],
    worktreePath: "/tmp/triflux/.codex-swarm/wt-worker-a",
  });

  assert.ok(
    result.includes(
      "작업 루트(절대경로): /tmp/triflux/.codex-swarm/wt-worker-a — 아래 lease 경로와 모든 상대경로는 이 루트 기준으로만 해석한다.",
    ),
  );
  assert.ok(result.includes("- hub/team/build-worker-prompt.mjs"));
});

test("buildLeaseScopedAcceptanceAppendix — lease 없으면 none declared 표시", () => {
  const result = buildLeaseScopedAcceptanceAppendix();
  assert.ok(result.includes("- (none declared)"));
});

test("COMPLETION_PROTOCOL_APPENDIX — 실패/차단 상태와 sha 검증 계약을 명시", () => {
  assert.ok(
    COMPLETION_PROTOCOL_APPENDIX.includes(
      "status 값은 ok | failed | blocked 중 하나",
    ),
  );
  assert.ok(
    COMPLETION_PROTOCOL_APPENDIX.includes(
      "payload 출력 직전 `git log -1 --format=%H` 로 보고할 sha 가 실재하는지 검증하라",
    ),
  );
  assert.ok(
    COMPLETION_PROTOCOL_APPENDIX.includes(
      "코드 변경이 기대되는 shard 에서 변경/커밋을 못 했으면 status:failed 와 함께 reason 필드로 사유를 보고하라",
    ),
  );
  assert.ok(
    COMPLETION_PROTOCOL_APPENDIX.includes(
      "no-op shard 는 status:ok + 빈 commits_made 배열 허용",
    ),
  );
  assert.equal(
    COMPLETION_PROTOCOL_APPENDIX.includes(
      "commits_made 가 비어 있어도 됨 (no-op shard)",
    ),
    false,
  );
});

test("buildWorkerPrompt — null/undefined/빈 prompt 도 appendix 만 포함", () => {
  for (const input of [null, undefined, ""]) {
    const result = buildWorkerPrompt(input);
    assert.ok(result.includes("Lease-scoped Acceptance / Lint Guard"));
    assert.ok(result.includes(SENTINEL_BEGIN));
    assert.ok(result.includes(SENTINEL_END));
  }
});

test("buildWorkerPrompt — non-string (숫자/객체) → 빈 body + appendix", () => {
  const result = buildWorkerPrompt(42);
  assert.equal(
    result,
    buildLeaseScopedAcceptanceAppendix() + COMPLETION_PROTOCOL_APPENDIX,
  );
});
