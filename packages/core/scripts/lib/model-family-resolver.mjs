import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveTrifluxHome } from "./machine-profile.mjs";

export const CODEX_FAMILY_PROFILES = Object.freeze({
  sol_high: { family: "sol", effort: "high", model: "gpt-6.1-sol" },
  sol_med: { family: "sol", effort: "medium", model: "gpt-6.1-sol" },
  astra_xhigh: { family: "astra", effort: "xhigh", model: "gpt-6-astra" },
  astra_max: { family: "astra", effort: "max", model: "gpt-6-astra" },
  astra_ultra: { family: "astra", effort: "ultra", model: "gpt-6-astra" },
  terra_high: { family: "terra", effort: "high", model: "gpt-6.1-terra" },
  luna_high: { family: "luna", effort: "high", model: "gpt-6-luna" },
  luna_low: { family: "luna", effort: "low", model: "gpt-6-luna" },
});
export const AGY_FAMILY_PROFILES = Object.freeze({
  argon_low: {
    family: "argon",
    effort: "low",
    model: "Gemini 4 Argon (Low)",
  },
  argon: {
    family: "argon",
    effort: "medium",
    model: "Gemini 4 Argon (Medium)",
  },
  argon_high: {
    family: "argon",
    effort: "high",
    model: "Gemini 4 Argon (High)",
  },
});
const DAY_MS = 86_400_000;
const CODEX_SLUG = /^gpt-(\d+(?:\.\d+)*)-(sol|astra|terra|luna)$/;
const AGY_SLUG = /^gemini-(\d+(?:\.\d+)*)-(argon)-(low|medium|high)$/;

function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] || 0) - (right[i] || 0);
    if (difference) return difference;
  }
  return 0;
}

export function selectCodexModel(models, family, effort) {
  return (
    (models || [])
      .filter((item) => {
        const match = CODEX_SLUG.exec(item?.slug);
        return (
          match?.[2] === family &&
          item.visibility === "list" &&
          Array.isArray(item.supported_reasoning_levels) &&
          item.supported_reasoning_levels.some(
            (level) => (level?.effort ?? level) === effort,
          )
        );
      })
      .sort((a, b) =>
        compareVersions(CODEX_SLUG.exec(b.slug)[1], CODEX_SLUG.exec(a.slug)[1]),
      )[0] || null
  );
}

export function parseAgyModels(output) {
  return String(output)
    .split(/\r?\n/)
    .flatMap((line) => {
      const [slug, model] = line.trim().split("\t");
      return AGY_SLUG.test(slug) && model?.trim()
        ? [{ slug, model: model.trim() }]
        : [];
    });
}

export function selectAgyModel(models, family, effort) {
  return (
    (models || [])
      .filter((item) => {
        const match = AGY_SLUG.exec(item?.slug);
        return (
          match?.[2] === family &&
          match?.[3] === effort &&
          typeof item.model === "string"
        );
      })
      .sort((a, b) =>
        compareVersions(AGY_SLUG.exec(b.slug)[1], AGY_SLUG.exec(a.slug)[1]),
      )[0] || null
  );
}

export function modelFamilyPaths(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const home = opts.home || resolveTrifluxHome({ env, platform });
  const stateDir =
    opts.stateDir ||
    join(
      platform === "win32"
        ? env.APPDATA || join(home, "AppData", "Roaming")
        : env.XDG_CONFIG_HOME || join(home, ".config"),
      "triflux",
    );
  return {
    home,
    stateDir,
    codexHome:
      opts.codexHome ||
      env.CODEX_HOME ||
      env.TFX_CODEX_HOME ||
      join(home, ".codex"),
    pinsPath: join(stateDir, "models.json"),
  };
}

function readJson(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

function signature(path) {
  try {
    const stat = statSync(path);
    return `${path}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return `${path}:missing`;
  }
}

export function writeModelFile(path, content) {
  try {
    if (readFileSync(path, "utf8") === content) return false;
  } catch {}
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
  return true;
}

function saveJson(path, value) {
  try {
    writeModelFile(path, `${JSON.stringify(value)}\n`);
  } catch {
    // 읽기 전용 상태 디렉터리여도 이번 실행의 해석 결과는 쓸 수 있다.
  }
}

const codexCatalogs = new Map();
export function readCodexModelCatalog(opts = {}) {
  const path = join(modelFamilyPaths(opts).codexHome, "models_cache.json");
  const key = signature(path);
  let cached = codexCatalogs.get(path);
  if (cached?.key !== key) {
    const value = readJson(path);
    cached = { key, catalog: Array.isArray(value?.models) ? value : null };
    codexCatalogs.set(path, cached);
  }
  return cached.catalog;
}

export function resolveModelFamilies(provider, opts = {}) {
  const paths = modelFamilyPaths(opts);
  const definitions =
    provider === "codex" ? CODEX_FAMILY_PROFILES : AGY_FAMILY_PROFILES;
  const recordPath = join(paths.stateDir, `${provider}-model-resolution.json`);
  const previous = readJson(recordPath) || {};
  const now = (opts.now || Date.now)();
  const fetchedAt = new Date(now).toISOString();
  const run =
    opts.runCommand ||
    ((command, args) =>
      execFileSync(command, args, {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          ...(opts.env || process.env),
          HOME: paths.home,
          CODEX_HOME: paths.codexHome,
        },
        maxBuffer: 4 * 1024 * 1024,
      }));
  let catalog = null;
  let sourceSignature;
  let checkedAt = previous.checked_at;
  if (provider === "codex") {
    const cachePath = join(paths.codexHome, "models_cache.json");
    sourceSignature = signature(cachePath);
    if (sourceSignature !== previous.sourceSignature)
      catalog = readCodexModelCatalog(opts);
    if (
      sourceSignature.endsWith(":missing") &&
      opts.allowCommand !== false &&
      (!checkedAt || now - Date.parse(checkedAt) >= DAY_MS)
    ) {
      checkedAt = fetchedAt;
      try {
        const parsed = JSON.parse(
          run(opts.command || "codex", ["debug", "models"]),
        );
        if (Array.isArray(parsed?.models))
          catalog = { ...parsed, fetched_at: parsed.fetched_at || fetchedAt };
      } catch {}
    }
  } else {
    const cachePath = join(paths.stateDir, "agy-models.json");
    let cached = readJson(cachePath) || {};
    if (
      opts.allowCommand !== false &&
      (!cached.checked_at || now - Date.parse(cached.checked_at) >= DAY_MS)
    ) {
      const lock = `${cachePath}.lock`;
      let acquired = false;
      try {
        if (opts.persist !== false) {
          mkdirSync(paths.stateDir, { recursive: true });
          // 프로세스가 끊긴 잠금만 회수한다. CLI 조회 제한은 10초다.
          try {
            if (now - statSync(lock).mtimeMs > 60_000)
              rmSync(lock, { recursive: true, force: true });
          } catch {}
          mkdirSync(lock);
          acquired = true;
          cached = readJson(cachePath) || cached;
        }
        if (
          !cached.checked_at ||
          now - Date.parse(cached.checked_at) >= DAY_MS
        ) {
          cached.checked_at = fetchedAt;
          try {
            const models = parseAgyModels(
              run(opts.command || "agy", ["models"]),
            );
            if (models.length)
              cached = { models, fetched_at: fetchedAt, checked_at: fetchedAt };
          } catch {}
          if (opts.persist !== false) saveJson(cachePath, cached);
        }
      } catch {
        // 다른 디스패치가 갱신 중이면 기존 결과로 실행한다.
      } finally {
        if (acquired) rmSync(lock, { recursive: true, force: true });
      }
    }
    sourceSignature = signature(cachePath);
    checkedAt = cached.checked_at;
    if (Array.isArray(cached.models)) catalog = cached;
  }
  const profiles = {};
  const selectedProfiles = {};
  const pins = readJson(paths.pinsPath) || {};
  for (const [name, definition] of Object.entries(definitions)) {
    const saved = previous.profiles?.[name];
    const last =
      typeof saved?.model === "string" && saved.effort === definition.effort
        ? saved
        : null;
    const candidate =
      provider === "codex"
        ? selectCodexModel(
            catalog?.models,
            definition.family,
            definition.effort,
          )
        : selectAgyModel(catalog?.models, definition.family, definition.effort);
    profiles[name] =
      candidate &&
      (!last?.fetched_at ||
        !catalog.fetched_at ||
        Date.parse(catalog.fetched_at) >= Date.parse(last.fetched_at))
        ? {
            model: provider === "codex" ? candidate.slug : candidate.model,
            effort: definition.effort,
            fetched_at: catalog.fetched_at || fetchedAt,
          }
        : last || {
            model: definition.model,
            effort: definition.effort,
            fetched_at: null,
          };
    selectedProfiles[name] = { ...profiles[name] };
    const pin = pins[definition.family];
    const agyPin =
      provider === "agy" && typeof pin === "string"
        ? AGY_SLUG.exec(`${pin}-${definition.effort}`)
        : null;
    if (
      typeof pin === "string" &&
      provider === "codex" &&
      CODEX_SLUG.exec(pin)?.[2] === definition.family
    ) {
      selectedProfiles[name] = {
        model: pin,
        effort: definition.effort,
        source: paths.pinsPath,
        fetched_at: null,
      };
    } else if (agyPin?.[2] === definition.family) {
      const slug = `${pin}-${definition.effort}`;
      const version = agyPin[1];
      const family =
        definition.family[0].toUpperCase() + definition.family.slice(1);
      const effort =
        definition.effort[0].toUpperCase() + definition.effort.slice(1);
      selectedProfiles[name] = {
        model:
          catalog?.models?.find((item) => item.slug === slug)?.model ||
          `Gemini ${version} ${family} (${effort})`,
        effort: definition.effort,
        source: paths.pinsPath,
        fetched_at: null,
      };
    }
  }
  const record = {
    sourceSignature,
    checked_at: checkedAt || null,
    profiles,
    selectedProfiles,
  };
  if (opts.persist !== false) saveJson(recordPath, record);
  return { profiles: selectedProfiles };
}
