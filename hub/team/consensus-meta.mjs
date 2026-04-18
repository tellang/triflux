const VALID_SHAPES = new Set(["consensus", "debate", "panel"]);
const VALID_ACTIONS = new Set(["merge", "FIX_FIRST", "close", "defer", "split"]);
const DEFAULT_SHAPE = "consensus";

export const CONSENSUS_SHAPE_COMPLEXITY = Object.freeze({
  consensus: 1.0,
  debate: 1.2,
  panel: 1.4,
});

export const CONSENSUS_MARKDOWN_SECTIONS = Object.freeze({
  consensus: Object.freeze([
    "## 합의 결과: {topic}",
    "### Consensus Score",
    "### 합의 항목",
    "### disputed items",
    "### resolved items",
    "### user decision needed",
    "### meta judgment",
  ]),
  debate: Object.freeze([
    "## 토론 결과: {topic}",
    "### 비교 대상",
    "### 평가 기준",
    "### 합의 사항",
    "### 최종 추천",
    "### 리스크 및 완화 방안",
    "### meta judgment",
  ]),
  panel: Object.freeze([
    "## 전문가 패널 보고서: {topic}",
    "### 패널 구성",
    "### 패널 합의",
    "### 소수 견해",
    "### 핵심 추천",
    "### 미해결 쟁점",
    "### 다음 단계",
    "### meta judgment",
  ]),
});

function toArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value == null) return [];
  return [value].filter(Boolean);
}

function normalizeShape(shape) {
  return VALID_SHAPES.has(shape) ? shape : DEFAULT_SHAPE;
}

function normalizeRecommendedAction(action) {
  return VALID_ACTIONS.has(action) ? action : "defer";
}

function normalizeStringList(items) {
  return [...new Set(toArray(items).map((item) => String(item).trim()).filter(Boolean))];
}

function normalizeSeverityBucket(items) {
  return toArray(items).map((item) =>
    typeof item === "string" ? { id: item, summary: item } : { ...item },
  );
}

function buildSeverityClassification({ p1 = [], p2 = [], p3 = [] } = {}) {
  return {
    p1: normalizeSeverityBucket(p1),
    p2: normalizeSeverityBucket(p2),
    p3: normalizeSeverityBucket(p3),
  };
}

function buildConsensusVsDispute({ agreements = [], conflicts = [] } = {}) {
  return {
    agreements: toArray(agreements).map((item) =>
      typeof item === "string" ? { summary: item } : { ...item },
    ),
    conflicts: toArray(conflicts).map((item) =>
      typeof item === "string" ? { summary: item, parties: [] } : { parties: [], ...item },
    ),
  };
}

function inferStatus(participants) {
  const statuses = participants.map((participant) => participant.status);
  if (statuses.length === 0) return "needs_user_input";
  if (statuses.every((status) => status === "success")) return "complete";
  if (statuses.some((status) => status === "needs_user_input")) return "needs_user_input";
  return "partial";
}

export function normalizeParticipants(participants = []) {
  return toArray(participants).map((participant) => {
    if (typeof participant === "string") {
      return { name: participant, status: "success" };
    }

    return {
      name: participant?.name ?? "unknown",
      status: participant?.status ?? "success",
      ...participant,
    };
  });
}

export function buildMetaJudgment({
  severity = {},
  consensus = {},
  recommendedAction = "defer",
  followupIssues = [],
  modeSpecificMeta = {},
} = {}) {
  return {
    severity_classification: buildSeverityClassification(severity),
    consensus_vs_dispute: buildConsensusVsDispute(consensus),
    recommended_action: normalizeRecommendedAction(recommendedAction),
    followup_issues: normalizeStringList(followupIssues),
    mode_specific_meta: { ...modeSpecificMeta },
  };
}

export function buildConsensusArtifactMeta({
  shape = DEFAULT_SHAPE,
  topic = "",
  cliSet = "triad",
  participants = [],
  status,
} = {}) {
  const normalizedParticipants = normalizeParticipants(participants);
  return {
    mode: "consensus",
    shape: normalizeShape(shape),
    topic,
    cli_set: cliSet,
    participants: normalizedParticipants,
    status: status ?? inferStatus(normalizedParticipants),
  };
}

export function buildConsensusEnvelope({
  shape = DEFAULT_SHAPE,
  topic = "",
  cliSet = "triad",
  participants = [],
  metaJudgment = {},
} = {}) {
  return {
    ...buildConsensusArtifactMeta({ shape, topic, cliSet, participants }),
    meta_judgment: buildMetaJudgment(metaJudgment),
  };
}

export function getShapeContract(shape = DEFAULT_SHAPE) {
  const normalizedShape = normalizeShape(shape);
  return {
    shape: normalizedShape,
    complexity: CONSENSUS_SHAPE_COMPLEXITY[normalizedShape],
    required_markdown_sections: CONSENSUS_MARKDOWN_SECTIONS[normalizedShape],
  };
}
