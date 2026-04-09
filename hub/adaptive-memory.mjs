import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SESSION_FILE = "adaptive-session.json";
const DEFAULT_CONFIDENCE = 0.5;
const TIER2_DECAY_STEP = 0.2;
const TIER2_DECAY_INTERVAL = 5;
const TIER2_REMOVE_THRESHOLD = 0.3;
const TIER3_WARN_THRESHOLD = 10;
const TIER3_REMOVE_THRESHOLD = 20;

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const clamp01 = (v) => {
  const n = Number(v);
  return Number.isFinite(n)
    ? Number(Math.max(0, Math.min(1, n)).toFixed(4))
    : DEFAULT_CONFIDENCE;
};
const toDate = (v = Date.now()) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? new Date().toISOString().slice(0, 10)
    : d.toISOString().slice(0, 10);
};
const uniq = (arr) => [
  ...new Set(arr.filter((s) => typeof s === "string" && s.trim())),
];
const slugify = (v) =>
  String(v || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
const buildId = (r) => {
  const e = slugify(r.id);
  if (e) return e;
  const p = slugify(r.pattern);
  return p || `adaptive-${Date.now()}`;
};
const readJson = (f, fb) => {
  if (!existsSync(f)) return clone(fb);
  try {
    return { ...clone(fb), ...JSON.parse(readFileSync(f, "utf8")) };
  } catch {
    return clone(fb);
  }
};
const writeJson = (f, v) =>
  writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`, "utf8");
const strip = (r) => {
  if (!r) return null;
  const { sessionIds, ...pub } = r;
  return clone(pub);
};
const sortRules = (list) =>
  [...list].sort(
    (a, b) =>
      a.tier - b.tier ||
      b.confidence - a.confidence ||
      a.id.localeCompare(b.id),
  );
const upsert = (list, r) => [...list.filter((x) => x.id !== r.id), r];
const without = (list, id) => list.filter((x) => x.id !== id);

function toRule(rule, tier, sessionId, existing = null) {
  return {
    id: existing?.id || buildId(rule),
    pattern: String(rule.pattern || existing?.pattern || ""),
    rootCause: String(
      rule.rootCause || rule.root_cause || existing?.rootCause || "",
    ),
    rule: String(rule.rule || existing?.rule || ""),
    confidence: clamp01(rule.confidence ?? existing?.confidence),
    occurrences: Math.max(1, Number(existing?.occurrences || 0) + 1),
    firstSeen: existing?.firstSeen || toDate(rule.timestamp),
    lastSeen: toDate(rule.timestamp),
    sessionsWithout: 0,
    tier,
    dnaFactor: rule.dnaFactor ?? rule.dna_factor ?? existing?.dnaFactor ?? null,
    sessionIds: uniq([...(existing?.sessionIds || []), sessionId]),
  };
}

export function createAdaptiveMemory(opts = {}) {
  const projectSlug = slugify(opts.projectSlug);
  if (!projectSlug) throw new Error("projectSlug is required");

  const sessionDir = opts.sessionDir || join(process.cwd(), ".omc", "state");
  const globalDir = opts.globalDir || join(homedir(), ".triflux", "adaptive");
  const sessionFile = join(sessionDir, SESSION_FILE);
  const projectFile = join(globalDir, `${projectSlug}.json`);

  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(globalDir, { recursive: true });

  let ss = readJson(sessionFile, { projectSlug, sessionId: null, rules: [] });
  let ps = readJson(projectFile, {
    projectSlug,
    history: {},
    tier2: [],
    tier3: [],
  });

  function saveSession() {
    if (ss.rules.length === 0) {
      rmSync(sessionFile, { force: true });
      return;
    }
    writeJson(sessionFile, ss);
  }

  function saveProject() {
    const has =
      Object.keys(ps.history).length > 0 ||
      ps.tier2.length > 0 ||
      ps.tier3.length > 0;
    if (!has) {
      rmSync(projectFile, { force: true });
      return;
    }
    writeJson(projectFile, ps);
  }

  const saveAll = () => {
    saveSession();
    saveProject();
  };

  function getSessionId(id) {
    const next = String(id || ss.sessionId || "session-current");
    ss = { ...ss, sessionId: next };
    return next;
  }

  const getDurable = (id) =>
    ps.tier3.find((r) => r.id === id) ||
    ps.tier2.find((r) => r.id === id) ||
    null;

  function promote(ruleId) {
    const t2 = ps.tier2.find((r) => r.id === ruleId);
    if (t2 && t2.occurrences >= 3 && t2.confidence >= 0.8) {
      const next = { ...t2, tier: 3, sessionsWithout: 0 };
      ps = {
        ...ps,
        tier2: without(ps.tier2, ruleId),
        tier3: upsert(ps.tier3, next),
      };
      saveProject();
      return { rule: strip(next), promoted: true, fromTier: 2, toTier: 3 };
    }
    const cand = ps.history[ruleId];
    if (cand && cand.occurrences >= 2 && cand.sessionIds.length >= 2) {
      const next = { ...cand, tier: 2, sessionsWithout: 0 };
      const { [ruleId]: _, ...history } = ps.history;
      ps = { ...ps, history, tier2: upsert(ps.tier2, next) };
      ss = { ...ss, rules: without(ss.rules, ruleId) };
      saveAll();
      return { rule: strip(next), promoted: true, fromTier: 1, toTier: 2 };
    }
    const cur = getDurable(ruleId) || ps.history[ruleId] || null;
    return {
      rule: strip(cur),
      promoted: false,
      fromTier: cur?.tier ?? null,
      toTier: cur?.tier ?? null,
    };
  }

  function record(rule = {}) {
    if (!rule.pattern)
      return { rule: null, promoted: false, fromTier: null, toTier: null };
    const sessionId = getSessionId(rule.sessionId);
    const ruleId = buildId(rule);
    const durable = getDurable(ruleId);
    if (durable) {
      const next = toRule(rule, durable.tier, sessionId, durable);
      ps =
        durable.tier === 3
          ? { ...ps, tier3: upsert(ps.tier3, next) }
          : { ...ps, tier2: upsert(ps.tier2, next) };
      saveProject();
      const res = promote(ruleId);
      return res.promoted
        ? res
        : {
            rule: strip(next),
            promoted: false,
            fromTier: durable.tier,
            toTier: durable.tier,
          };
    }
    const cand = toRule(rule, 1, sessionId, ps.history[ruleId]);
    ps = { ...ps, history: { ...ps.history, [ruleId]: cand } };
    ss = { ...ss, rules: upsert(ss.rules, { ...cand, tier: 1 }) };
    saveAll();
    const res = promote(ruleId);
    return res.promoted
      ? res
      : { rule: strip(cand), promoted: false, fromTier: 1, toTier: 1 };
  }

  function decay(sessionId) {
    const nextId = String(sessionId || `session-${Date.now()}`);
    if (ss.sessionId === nextId)
      return {
        sessionId: nextId,
        tier1Cleared: 0,
        updated: [],
        warned: [],
        removed: [],
      };
    const warned = [],
      removed = [],
      updated = [];
    const tier1Cleared = ss.rules.length;
    const tier2 = ps.tier2.flatMap((r) => {
      const sw = Number(r.sessionsWithout || 0) + 1;
      const conf =
        sw % TIER2_DECAY_INTERVAL === 0
          ? clamp01(r.confidence - TIER2_DECAY_STEP)
          : r.confidence;
      if (conf < TIER2_REMOVE_THRESHOLD) {
        removed.push(r.id);
        return [];
      }
      updated.push(r.id);
      return [{ ...r, sessionsWithout: sw, confidence: conf }];
    });
    const tier3 = ps.tier3.flatMap((r) => {
      const sw = Number(r.sessionsWithout || 0) + 1;
      if (sw >= TIER3_REMOVE_THRESHOLD) {
        removed.push(r.id);
        return [];
      }
      if (sw === TIER3_WARN_THRESHOLD) warned.push(r.id);
      updated.push(r.id);
      return [{ ...r, sessionsWithout: sw }];
    });
    ss = { ...ss, sessionId: nextId, rules: [] };
    ps = { ...ps, tier2, tier3 };
    saveAll();
    return { sessionId: nextId, tier1Cleared, updated, warned, removed };
  }

  function getRule(id) {
    return strip(ss.rules.find((r) => r.id === id) || getDurable(id));
  }
  function getTier(tier) {
    if (tier === 1) return sortRules(ss.rules).map(strip);
    if (tier === 2) return sortRules(ps.tier2).map(strip);
    if (tier === 3) return sortRules(ps.tier3).map(strip);
    return [];
  }
  function getAllRules() {
    return sortRules([...ss.rules, ...ps.tier2, ...ps.tier3]).map(strip);
  }
  function reset(target = "all") {
    const rs = target === "all" || target === 1 || target === "session";
    const rp =
      target === "all" || target === 2 || target === 3 || target === "project";
    if (rs) ss = { ...ss, rules: [] };
    if (rp) ps = { ...ps, history: {}, tier2: [], tier3: [] };
    saveAll();
    return { sessionCleared: rs, projectCleared: rp };
  }

  return { record, promote, decay, getRule, getAllRules, getTier, reset };
}
