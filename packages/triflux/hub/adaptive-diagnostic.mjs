import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeError } from "./reflexion.mjs";

const DEFAULT_KNOWN_ERRORS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "lib/known-errors.json",
);
const DEFAULT_CONFIDENCE = 0.5;
const ADAPTIVE_CONFIDENCE_STEP = 0.1;
const MAX_ADAPTIVE_CONFIDENCE = 0.95;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function pickString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function pickObject(...values) {
  return (
    values.find(
      (value) => value && typeof value === "object" && !Array.isArray(value),
    ) || {}
  );
}

function clampConfidence(value, fallback = DEFAULT_CONFIDENCE) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function normalizeLookup(text) {
  return String(text || "")
    .trim()
    .toLowerCase();
}

function readPathValue(source, path) {
  if (!source || !path) return undefined;
  return String(path)
    .split(".")
    .filter(Boolean)
    .reduce((current, key) => current?.[key], source);
}

function renderTemplate(template, observation, signature) {
  if (!template) return "";
  const context = pickObject(observation.context);
  const dna = pickObject(observation.dna);
  const dnaValue = signature.dna_factor
    ? (readPathValue(dna, signature.dna_factor) ??
      readPathValue(context, signature.dna_factor) ??
      readPathValue(observation, signature.dna_factor))
    : undefined;
  const variables = {
    ...context,
    ...pickObject(observation.variables),
    host: pickString(observation.host, context.host),
    value: dnaValue,
  };
  return String(template).replace(/\{([^}]+)\}/gu, (match, key) => {
    const value = variables[key];
    return value == null || value === "" ? match : String(value);
  });
}

function buildKnownContextText(observation) {
  return normalizeLookup(
    [
      pickString(observation.contextLabel, observation.context),
      pickString(observation.phase),
      pickString(observation.step),
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function buildErrorText(observation = {}) {
  return [
    pickString(observation.error),
    pickString(observation.stderr),
    pickString(observation.tool_output, observation.output),
    pickString(observation.message),
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
}

function normalizeObservation(observation = {}) {
  const errorText = buildErrorText(observation);
  const projectSlug = pickString(
    observation.project_slug,
    observation.projectSlug,
    observation.context?.project_slug,
    observation.context?.projectSlug,
  );
  return {
    ...clone(observation),
    errorText,
    errorPattern: normalizeError(errorText),
    projectSlug,
    tool: pickString(observation.tool, observation.tool_name),
    contextText: buildKnownContextText(observation),
  };
}

function compileSignatures(raw = {}) {
  return Object.entries(raw.signatures || {}).map(([id, signature]) => ({
    id,
    ...clone(signature),
    matcher: new RegExp(String(signature.pattern || ""), "iu"),
  }));
}

export function loadKnownErrors(filePath = DEFAULT_KNOWN_ERRORS_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return {
      path: filePath,
      version: parsed.version ?? 1,
      signatures: compileSignatures(parsed),
    };
  } catch {
    return { path: filePath, version: 0, signatures: [] };
  }
}

function scoreKnownMatch(signature, observation) {
  if (
    !observation.errorText ||
    !signature.matcher.test(observation.errorText)
  ) {
    return null;
  }
  if (
    signature.tool &&
    observation.tool &&
    normalizeLookup(signature.tool) !== normalizeLookup(observation.tool)
  ) {
    return null;
  }
  if (
    signature.context &&
    observation.contextText &&
    !observation.contextText.includes(normalizeLookup(signature.context))
  ) {
    return null;
  }
  return clampConfidence(
    Number(signature.confidence_base ?? DEFAULT_CONFIDENCE) +
      (signature.tool && observation.tool ? 0.02 : 0) +
      (signature.context && observation.contextText ? 0.02 : 0) +
      (signature.dna_factor ? 0.01 : 0),
  );
}

function severityFromConfidence(confidence, fallback = "medium") {
  if (confidence >= 0.9) return "critical";
  if (confidence >= 0.75) return "high";
  if (confidence >= 0.55) return "medium";
  return fallback;
}

export function matchKnownError(catalog, observationInput = {}) {
  const observation = normalizeObservation(observationInput);
  const matched = (catalog?.signatures || [])
    .map((signature) => {
      const confidence = scoreKnownMatch(signature, observation);
      return confidence == null ? null : { signature, confidence };
    })
    .filter(Boolean)
    .sort((left, right) => right.confidence - left.confidence)[0];

  if (!matched) return null;
  const { signature, confidence } = matched;
  return {
    matched: true,
    source: "known",
    signature_id: signature.id,
    project_slug: observation.projectSlug,
    error_pattern: observation.errorPattern,
    error_message: observation.errorText,
    confidence,
    severity: signature.severity || severityFromConfidence(confidence),
    tool: signature.tool || observation.tool,
    context: signature.context || observation.contextText || null,
    root_cause: signature.root_cause || "known failure pattern",
    rule: renderTemplate(signature.rule_template, observation, signature),
    fix: signature.fix || null,
    dna_factor: signature.dna_factor || null,
  };
}

function resolveRuleStore(options = {}) {
  return options.store || options.adaptiveMemory || null;
}

function ensureAdaptiveRule(store, observation) {
  if (
    !store?.findAdaptiveRule ||
    !store?.addAdaptiveRule ||
    !observation.projectSlug
  ) {
    return null;
  }
  const identity = {
    project_slug: observation.projectSlug,
    pattern: observation.errorPattern,
  };
  const current = store.findAdaptiveRule(
    identity.project_slug,
    identity.pattern,
  );
  if (!current) {
    return store.addAdaptiveRule(identity);
  }
  if (!store.updateRuleConfidence) return current;
  return store.updateRuleConfidence(
    identity.project_slug,
    identity.pattern,
    Math.min(
      MAX_ADAPTIVE_CONFIDENCE,
      current.confidence + ADAPTIVE_CONFIDENCE_STEP,
    ),
    { hit_count_increment: 1 },
  );
}

function buildAdaptiveDiagnosis(rule, observation) {
  if (!rule) {
    return {
      matched: false,
      source: "novel",
      project_slug: observation.projectSlug,
      error_pattern: observation.errorPattern,
      error_message: observation.errorText,
      confidence: DEFAULT_CONFIDENCE,
      severity: "low",
      root_cause: "새로운 실패 패턴으로 분류됨",
      rule: "",
      fix: null,
    };
  }
  const matched =
    Number(rule.hit_count || 0) > 1 ||
    Number(rule.confidence || 0) > DEFAULT_CONFIDENCE;
  const confidence = clampConfidence(rule.confidence, DEFAULT_CONFIDENCE);
  return {
    matched,
    source: matched ? "adaptive" : "novel",
    project_slug: rule.project_slug,
    error_pattern: rule.pattern,
    error_message: observation.errorText,
    confidence,
    severity: severityFromConfidence(confidence, matched ? "medium" : "low"),
    root_cause: matched
      ? "반복 관측된 adaptive rule과 일치"
      : "adaptive memory에 첫 관측으로 저장됨",
    rule: matched
      ? `프로젝트 ${rule.project_slug}에서 동일 패턴이 ${rule.hit_count}회 관측되었습니다.`
      : `프로젝트 ${rule.project_slug}의 adaptive memory에 패턴을 기록했습니다.`,
    fix: matched
      ? "최근 성공한 수정/회피 전략을 재적용하세요."
      : "추가 관측 후 adaptive rule을 승격하세요.",
    adaptive_rule: clone(rule),
  };
}

function createHealthyState(catalog) {
  return {
    state: "healthy",
    known_errors_count: catalog.signatures.length,
    last_error: null,
  };
}

function createDegradedState(error) {
  return {
    state: "degraded",
    known_errors_count: 0,
    last_error: {
      name: error?.name || "Error",
      message: error?.message || "unknown adaptive diagnostic error",
    },
  };
}

export function createDiagnosticPipeline(options = {}) {
  const store = resolveRuleStore(options);
  let catalog = options.knownErrors
    ? { signatures: compileSignatures({ signatures: options.knownErrors }) }
    : null;
  let health = catalog ? createHealthyState(catalog) : null;

  function ensureCatalog() {
    if (catalog) return catalog;
    try {
      catalog = loadKnownErrors(
        options.knownErrorsPath || DEFAULT_KNOWN_ERRORS_PATH,
      );
      health = createHealthyState(catalog);
    } catch (error) {
      catalog = { signatures: [] };
      health = createDegradedState(error);
    }
    return catalog;
  }

  function diagnoseFailure(observationInput = {}) {
    const observation = normalizeObservation(observationInput);
    const nextCatalog = ensureCatalog();
    const known = matchKnownError(nextCatalog, observation);
    if (known) return known;
    const adaptiveRule = observation.errorPattern
      ? ensureAdaptiveRule(store, observation)
      : null;
    return buildAdaptiveDiagnosis(adaptiveRule, observation);
  }

  function getHealth() {
    return clone(health || (ensureCatalog() && health));
  }

  function listKnownErrors() {
    return (ensureCatalog().signatures || []).map(({ matcher, ...signature }) =>
      clone(signature),
    );
  }

  return Object.freeze({
    diagnose: diagnoseFailure,
    diagnoseFailure,
    run: diagnoseFailure,
    getHealth,
    listKnownErrors,
  });
}

export { DEFAULT_KNOWN_ERRORS_PATH };
export default createDiagnosticPipeline;
