// hub/team/build-worker-prompt.mjs — append Completion Protocol to PRD prompt (#125)
//
// swarm-hypervisor injects a Completion Protocol appendix into every worker
// prompt so that workers emit a sentinel-framed JSON payload conductor.mjs can
// reliably capture (see sentinel-capture.mjs and extract-completion-payload.mjs).
//
// Pure module — no I/O — so the appendix and merge logic can be unit-tested
// without spawning conductors.

import { SENTINEL_BEGIN, SENTINEL_END } from "./sentinel-capture.mjs";

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
- commits_made 가 비어 있어도 됨 (no-op shard)
- 마커 쌍은 stdout 에 정확히 한 번만 출력해야 함. 재emit 시 conductor 는 첫 BEGIN..END 한 쌍만 채택하며, 이후 stdout 은 무시한다.
- ${SENTINEL_BEGIN} 만 출력하고 ${SENTINEL_END} 누락 시 conductor 가 truncation 으로 명확히 reject
`;

/**
 * Append the Completion Protocol section to a PRD prompt.
 *
 * @param {string|null|undefined} prdPrompt — original PRD body
 * @returns {string} prompt with appendix
 */
export function buildWorkerPrompt(prdPrompt) {
  const body = typeof prdPrompt === "string" ? prdPrompt : "";
  return body + COMPLETION_PROTOCOL_APPENDIX;
}
