// hub/workers/interface.mjs — Worker 공통 인터페이스 정의

/**
 * 워커 실행 옵션
 * @typedef {object} WorkerExecuteOptions
 * @property {string} [cwd] - 워커 작업 디렉터리
 * @property {string} [sessionKey] - 내부 세션 키
 * @property {string} [threadId] - 외부에서 지정한 Codex threadId
 * @property {boolean} [resetSession] - 기존 세션을 무시하고 새 세션 시작 여부
 * @property {string} [model] - Codex 모델 이름
 * @property {string} [profile] - Codex 프로필 이름
 * @property {'untrusted'|'on-failure'|'on-request'|'never'} [approvalPolicy] - 승인 정책
 * @property {'read-only'|'workspace-write'|'danger-full-access'} [sandbox] - 샌드박스 정책
 * @property {Record<string, unknown>} [config] - 추가 Codex 설정
 * @property {string} [baseInstructions] - 기본 시스템 지침
 * @property {string} [developerInstructions] - 개발자 지침
 * @property {string} [compactPrompt] - 컴팩션 프롬프트
 * @property {number} [timeoutMs] - MCP 요청 타임아웃(ms)
 */

/**
 * 워커 구조화 오류 메타데이터
 * @typedef {object} WorkerErrorInfo
 * @property {string} code - 오류 코드
 * @property {boolean} retryable - 재시도 대상 여부
 * @property {number} attempts - 실행 시도 횟수
 * @property {'transient'|'auth'|'config'|'input'} category - 오류 분류
 * @property {string} recovery - 권장 복구 가이드
 */

/**
 * 워커 실행 결과
 * @typedef {object} WorkerResult
 * @property {string} output - 최종 텍스트 출력
 * @property {number} exitCode - 종료 코드(0=성공)
 * @property {string | null} [threadId] - Codex 세션 threadId
 * @property {string | null} [sessionKey] - 내부 세션 키
 * @property {WorkerErrorInfo} [error] - 구조화 오류 메타데이터
 * @property {unknown} [raw] - 원본 tool call 결과
 */

/**
 * 공통 워커 인터페이스
 * @typedef {object} IWorker
 * @property {(prompt: string, opts?: WorkerExecuteOptions) => Promise<WorkerResult>} execute
 * @property {() => Promise<void>} start
 * @property {() => Promise<void>} stop
 * @property {() => boolean} isReady
 * @property {string} type - 'codex' | 'gemini' | 'claude' | 'delegator'
 */

export const WORKER_TYPES = Object.freeze(['codex', 'gemini', 'claude', 'delegator']);
