// hub/team/handoff.mjs — Worker → Lead handoff 프로토콜
// HANDOFF 블록 파싱, 검증, fallback 생성, Lead 포맷팅
// 설계: docs/design/handoff-schema-v7.md

// ── enum 허용 값 ──
const STATUS_VALUES = ["ok", "partial", "failed"];
const LEAD_ACTION_VALUES = ["accept", "needs_read", "retry", "reassign"];
const CONFIDENCE_VALUES = ["high", "medium", "low"];
const RISK_VALUES = ["low", "med", "high"];
const ERROR_STAGE_VALUES = ["dispatch", "execution", "timeout"];
const YES_NO = ["yes", "no"];

const TOKEN_HARD_CAP = 150;
const HANDOFF_MARKER = "--- HANDOFF ---";

/**
 * 워커 프롬프트에 삽입할 HANDOFF 블록 생성 지시
 */
export const HANDOFF_INSTRUCTION = `
After completing the task, you MUST output a HANDOFF block in exactly this format at the end of your response:

--- HANDOFF ---
status: ok | partial | failed
lead_action: accept | needs_read | retry | reassign
task: <1-3 word task type>
files_changed: <comma-separated file paths, or "none">
verdict: <one sentence conclusion>
confidence: high | medium | low
risk: low | med | high
detail: <result file path if available, or "none">

If the task failed, also include:
error_stage: dispatch | execution | timeout
retryable: yes | no
partial_output: yes | no

Rules:
- The HANDOFF block must start with exactly "--- HANDOFF ---"
- Each field must be on its own line as "key: value"
- verdict must be a single concise sentence
- Do not skip any required field
`.trim();

/**
 * CLI 프롬프트 길이 제한을 고려한 축약 HANDOFF 지시
 */
export const HANDOFF_INSTRUCTION_SHORT =
`After completing, output this block at the end:
--- HANDOFF ---
status: ok | partial | failed
lead_action: accept | needs_read | retry | reassign
verdict: <one sentence>
files_changed: <comma-separated paths or "none">
confidence: high | medium | low`;

/**
 * raw 텍스트에서 HANDOFF 블록을 파싱한다.
 * @param {string} rawText
 * @returns {object|null} 파싱된 필드 객체, 블록이 없으면 null
 */
export function parseHandoff(rawText) {
  if (!rawText || typeof rawText !== "string") return null;

  // P1 fix: 마지막 HANDOFF 블록을 파싱 (프롬프트 에코로 인한 중복 마커 대응)
  const markerIdx = rawText.lastIndexOf(HANDOFF_MARKER);
  if (markerIdx === -1) return null;

  const blockStart = markerIdx + HANDOFF_MARKER.length;
  // 다음 "---" 마커 또는 텍스트 끝까지
  const rest = rawText.slice(blockStart);
  const endIdx = rest.indexOf("\n---");
  const block = endIdx === -1 ? rest : rest.slice(0, endIdx);

  const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
  const parsed = {};

  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim().toLowerCase().replace(/\s+/g, "_");
    const value = line.slice(colonIdx + 1).trim();
    if (key && value) parsed[key] = value;
  }

  // files_changed: 쉼표 구분 → 배열
  if (parsed.files_changed) {
    if (parsed.files_changed === "none") {
      parsed.files_changed = [];
    } else {
      parsed.files_changed = parsed.files_changed
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean);
    }
  }

  return Object.keys(parsed).length > 0 ? parsed : null;
}

/**
 * 토큰 수 추정 (rough: chars/4)
 * @param {object} obj
 * @returns {number}
 */
function estimateTokens(obj) {
  return Math.ceil(JSON.stringify(obj).length / 4);
}

/**
 * enum 값 검증. 유효하지 않으면 null 반환.
 * @param {string} value
 * @param {string[]} allowed
 * @returns {string|null}
 */
function validateEnum(value, allowed) {
  if (!value) return null;
  const normalized = value.toLowerCase().trim();
  return allowed.includes(normalized) ? normalized : null;
}

/**
 * 파싱된 handoff를 검증하고 정규화한다.
 * @param {object} parsed — parseHandoff() 결과
 * @param {object} [context]
 * @param {number} [context.exitCode]
 * @param {string} [context.resultFile]
 * @param {string[]} [context.gitDiffFiles]
 * @returns {{ handoff: object, valid: boolean, warnings: string[] }}
 */
export function validateHandoff(parsed, context = {}) {
  const warnings = [];
  const h = { ...parsed };

  // context에서 자동 삽입 (누락 필드)
  if (!h.status && context.exitCode !== undefined) {
    h.status = context.exitCode === 0 ? "ok" : "failed";
    warnings.push("status: context.exitCode에서 추론");
  }
  if (!h.detail && context.resultFile) {
    h.detail = context.resultFile;
    warnings.push("detail: context.resultFile에서 추론");
  }
  if (!h.files_changed && context.gitDiffFiles) {
    h.files_changed = context.gitDiffFiles;
    warnings.push("files_changed: context.gitDiffFiles에서 추론");
  }

  // enum 검증 + 정규화
  const enumChecks = [
    ["status", STATUS_VALUES, "ok"],
    ["lead_action", LEAD_ACTION_VALUES, "needs_read"],
    ["confidence", CONFIDENCE_VALUES, "low"],
    ["risk", RISK_VALUES, "low"],
  ];

  for (const [field, allowed, fallback] of enumChecks) {
    if (h[field]) {
      const validated = validateEnum(h[field], allowed);
      if (!validated) {
        warnings.push(`${field}: "${h[field]}" → fallback "${fallback}"`);
        h[field] = fallback;
      } else {
        h[field] = validated;
      }
    }
  }

  // 실패 시 추가 필드 검증
  if (h.status === "failed" || h.status === "partial") {
    if (h.error_stage) {
      const v = validateEnum(h.error_stage, ERROR_STAGE_VALUES);
      if (!v) { warnings.push(`error_stage: "${h.error_stage}" invalid`); delete h.error_stage; }
      else h.error_stage = v;
    }
    for (const f of ["retryable", "partial_output"]) {
      if (h[f]) {
        const v = validateEnum(h[f], YES_NO);
        if (!v) { warnings.push(`${f}: "${h[f]}" invalid`); delete h[f]; }
        else h[f] = v;
      }
    }
  }

  // P2a: 필수 필드 체크 (핵심 3 + 라우팅용 4)
  const coreRequired = ["status", "lead_action", "verdict"];
  const routingRequired = ["task", "confidence", "risk", "detail"];
  for (const f of coreRequired) {
    if (!h[f]) warnings.push(`missing required: ${f}`);
  }
  for (const f of routingRequired) {
    if (!h[f]) warnings.push(`missing routing field: ${f}`);
  }

  // P2b: 토큰 cap + 트림
  const tokens = estimateTokens(h);
  if (tokens > TOKEN_HARD_CAP) {
    h.lead_action = "needs_read";
    // verdict 트림 (80자 + 말줄임)
    if (h.verdict && h.verdict.length > 80) {
      h.verdict = h.verdict.slice(0, 77) + "...";
    }
    // files_changed 트림 (최대 3개 + "and N more")
    if (Array.isArray(h.files_changed) && h.files_changed.length > 3) {
      const rest = h.files_changed.length - 3;
      h.files_changed = [...h.files_changed.slice(0, 3), `+${rest} more`];
    }
    warnings.push(`token cap exceeded (${tokens} > ${TOKEN_HARD_CAP}), trimmed`);
  }

  const missingCore = coreRequired.filter((f) => !h[f]);
  const missingRouting = routingRequired.filter((f) => !h[f]);
  const valid = missingCore.length === 0 && missingRouting.length === 0;

  return { handoff: h, valid, warnings };
}

/**
 * 워커가 HANDOFF 블록을 생성하지 않은 경우 fallback 생성.
 * @param {number} exitCode
 * @param {string} resultFile
 * @param {string} [cli]
 * @returns {object}
 */
export function buildFallbackHandoff(exitCode, resultFile, cli) {
  const ok = exitCode === 0;
  return {
    status: ok ? "ok" : "failed",
    lead_action: ok ? "accept" : "retry",
    task: "unknown",
    files_changed: [],
    verdict: `${cli || "worker"} completed (exit ${exitCode})`,
    confidence: "low",
    risk: "low",
    detail: resultFile || "none",
    ...(ok ? {} : {
      error_stage: exitCode === 124 ? "timeout" : "execution",
      retryable: exitCode === 124 ? "no" : "yes",
    }),
    _fallback: true,
  };
}

/**
 * Lead stdout용 최소 포맷 (80-120 토큰 목표)
 * @param {object} handoff
 * @returns {string}
 */
export function formatHandoffForLead(handoff) {
  const h = handoff;
  const files = Array.isArray(h.files_changed)
    ? (h.files_changed.length > 0 ? h.files_changed.join(", ") : "none")
    : (h.files_changed || "none");

  const lines = [
    `[HANDOFF] status=${h.status || "?"} action=${h.lead_action || "?"} confidence=${h.confidence || "?"}`,
    `verdict: ${h.verdict || "(no verdict)"}`,
    `files: ${files}`,
    `detail: ${h.detail || "none"}`,
  ];

  if (h.status === "failed" || h.status === "partial") {
    const parts = [];
    if (h.error_stage) parts.push(`stage=${h.error_stage}`);
    if (h.retryable) parts.push(`retryable=${h.retryable}`);
    if (parts.length) lines.push(`error: ${parts.join(" ")}`);
  }

  return lines.join("\n");
}

/**
 * 전체 파이프라인: raw text → parse → validate → format
 * @param {string} rawText — 워커 전체 출력
 * @param {object} [context] — { exitCode, resultFile, gitDiffFiles }
 * @returns {{ handoff: object, formatted: string, valid: boolean, warnings: string[], fallback: boolean }}
 */
export function processHandoff(rawText, context = {}) {
  const parsed = parseHandoff(rawText);

  if (!parsed) {
    const fb = buildFallbackHandoff(
      context.exitCode ?? 1,
      context.resultFile || "none",
      context.cli,
    );
    return {
      handoff: fb,
      formatted: formatHandoffForLead(fb),
      valid: false,
      warnings: ["HANDOFF block not found, using fallback"],
      fallback: true,
    };
  }

  const { handoff, valid, warnings } = validateHandoff(parsed, context);
  return {
    handoff,
    formatted: formatHandoffForLead(handoff),
    valid,
    warnings,
    fallback: false,
  };
}
