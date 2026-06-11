// hub/team/build-worker-prompt.mjs — append Completion Protocol to PRD prompt (#125)
//
// swarm-hypervisor injects a Completion Protocol appendix into every worker
// prompt so that workers emit a sentinel-framed JSON payload conductor.mjs can
// reliably capture (see sentinel-capture.mjs and extract-completion-payload.mjs).
//
// Pure module — no I/O — so the appendix and merge logic can be unit-tested
// without spawning conductors.

import { SENTINEL_BEGIN, SENTINEL_END } from "./sentinel-capture.mjs";

function normalizeLeaseFiles(leaseFiles) {
  if (!Array.isArray(leaseFiles)) return [];
  return leaseFiles
    .map((file) => (typeof file === "string" ? file.trim() : ""))
    .filter(Boolean);
}

function formatLeaseFiles(leaseFiles) {
  const normalized = normalizeLeaseFiles(leaseFiles);
  if (normalized.length === 0) return "- (none declared)";
  return normalized.map((file) => `- ${file}`).join("\n");
}

function normalizeWorktreePath(worktreePath) {
  return typeof worktreePath === "string" ? worktreePath.trim() : "";
}

export function buildLeaseScopedAcceptanceAppendix({
  leaseFiles = [],
  worktreePath,
} = {}) {
  const normalizedWorktreePath = normalizeWorktreePath(worktreePath);
  const rootLine = normalizedWorktreePath
    ? `작업 루트(절대경로): ${normalizedWorktreePath} — 아래 lease 경로와 모든 상대경로는 이 루트 기준으로만 해석한다.\n`
    : "";

  return `

## Lease-scoped Acceptance / Lint Guard (자동 삽입됨)
${rootLine}- 위 PRD 본문의 모든 제약과 acceptance 기준은 이 appendix 이후에도 그대로 유효하다.
- 이 shard 의 파일 lease:
${formatLeaseFiles(leaseFiles)}
- Acceptance, lint, and format checks are scoped to files changed by this shard; if that set is unclear, use only the lease list above.
- Do not run repo-wide format/lint fixers such as \`biome check --write .\`, \`biome --write .\`, \`npm run lint:fix\`, or broad \`npm run lint\` to absorb unrelated drift.
- For Biome, use \`npx biome check <changed-files-or-lease-files>\`; add \`--write\` only when every target is a changed/leased file you intend to commit.
- Pre-existing lint drift outside the lease is not this shard's acceptance responsibility; report it instead of editing it.
`;
}

export const COMPLETION_PROTOCOL_APPENDIX = `

## Completion Protocol (자동 삽입됨)
<!-- swarm hypervisor 가 이 섹션을 worker prompt 에 자동 주입합니다.
     PRD 작성자는 이 섹션을 수정하지 마세요.
     상세: hub/team/build-worker-prompt.mjs / sentinel-capture.mjs (#125). -->

작업의 마지막 단계로, stdout 에 다음 형식의 완료 payload 를 정확히 한 번 출력하라:

${SENTINEL_BEGIN}
{"shard":"<shard name>","status":"ok","commits_made":[{"sha":"<40-char full sha>","message":"<commit msg>"}]}
${SENTINEL_END}

규약:
- 두 sentinel 마커는 각자 자기 줄에 단독으로 출력 (앞뒤 newline)
- 마커 사이 본문은 단일 JSON object (배열/primitive 금지)
- status 값은 ok | failed | blocked 중 하나
- payload 출력 직전 \`git log -1 --format=%H\` 로 보고할 sha 가 실재하는지 검증하라
- 코드 변경이 기대되는 shard 에서 변경/커밋을 못 했으면 status:failed 와 함께 reason 필드로 사유를 보고하라 — 그 경우 빈 commits_made 에 status:ok 는 금지
- no-op shard 는 status:ok + 빈 commits_made 배열 허용
- 마커 쌍은 stdout 에 정확히 한 번만 출력해야 함. 재emit 시 conductor 는 첫 BEGIN..END 한 쌍만 채택하며, 이후 stdout 은 무시한다.
- ${SENTINEL_BEGIN} 만 출력하고 ${SENTINEL_END} 누락 시 conductor 가 truncation 으로 명확히 reject
`;

/**
 * Append the Completion Protocol section to a PRD prompt.
 *
 * @param {string|null|undefined} prdPrompt — original PRD body
 * @param {{ leaseFiles?: string[], worktreePath?: string }} [opts] — shard file lease and absolute worktree root for scoped acceptance
 * @returns {string} prompt with appendix
 */
export function buildWorkerPrompt(prdPrompt, opts = {}) {
  const body = typeof prdPrompt === "string" ? prdPrompt : "";
  return (
    body +
    buildLeaseScopedAcceptanceAppendix({
      leaseFiles: opts.leaseFiles,
      worktreePath: opts.worktreePath,
    }) +
    COMPLETION_PROTOCOL_APPENDIX
  );
}
