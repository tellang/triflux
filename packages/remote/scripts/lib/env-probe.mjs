import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { whichCommand, whichCommandAsync } from "@triflux/core/hub/platform.mjs";

const CLI_PROBE_CACHE = new Map();
const CLI_PROBE_PROMISES = new Map();

function normalizeCliName(name) {
  return String(name ?? "").trim() || null;
}

function toCliResult(path) {
  return path ? { ok: true, path } : { ok: false };
}

function cloneCliResult(result) {
  return result?.ok ? { ...result } : { ok: false };
}

function readCachedCliResult(name) {
  const cached = CLI_PROBE_CACHE.get(name);
  return cached ? cloneCliResult(cached) : null;
}

function storeCliResult(name, result) {
  const snapshot = cloneCliResult(result);
  CLI_PROBE_CACHE.set(name, snapshot);
  return cloneCliResult(snapshot);
}

function buildCliProbeOptions(options = {}) {
  return {
    timeout: options.timeout ?? 2000,
    env: options.env,
    cwd: options.cwd,
    platform: options.platform,
  };
}

function normalizeCliNames(names) {
  return [...new Set((names || []).map(normalizeCliName).filter(Boolean))];
}

function mapCliResults(names, results) {
  return names.reduce(
    (acc, name, index) => ({
      ...acc,
      [name]: results[index],
    }),
    {},
  );
}

async function resolveCliProbe(name, options = {}) {
  const path = await (options.whichCommandAsyncFn || whichCommandAsync)(name, {
    ...buildCliProbeOptions(options),
    execFileFn: options.execFileFn,
  });
  return toCliResult(path);
}

async function checkCli(name, options = {}) {
  const cliName = normalizeCliName(name);
  if (!cliName) return { ok: false };

  const cached = readCachedCliResult(cliName);
  if (cached) return cached;

  const pending = CLI_PROBE_PROMISES.get(cliName);
  if (pending) return pending.then(cloneCliResult);

  const nextProbe = resolveCliProbe(cliName, options)
    .then((result) => storeCliResult(cliName, result))
    .catch(() => storeCliResult(cliName, { ok: false }))
    .finally(() => {
      CLI_PROBE_PROMISES.delete(cliName);
    });

  CLI_PROBE_PROMISES.set(cliName, nextProbe);
  return nextProbe.then(cloneCliResult);
}

export function checkCliSync(name, options = {}) {
  const cliName = normalizeCliName(name);
  if (!cliName) return { ok: false };

  const cached = readCachedCliResult(cliName);
  if (cached) return cached;

  const path = (options.whichCommandFn || whichCommand)(
    cliName,
    buildCliProbeOptions(options),
  );
  return storeCliResult(cliName, toCliResult(path));
}

export async function probeClis(names, options = {}) {
  const cliNames = normalizeCliNames(names);
  const results = await Promise.all(
    cliNames.map((name) => checkCli(name, options)),
  );
  return mapCliResults(cliNames, results);
}

export function detectCodexAuthState({
  homeDir = homedir(),
  existsSyncFn = existsSync,
  readFileSyncFn = readFileSync,
} = {}) {
  try {
    const authPath = join(homeDir, ".codex", "auth.json");
    if (!existsSyncFn(authPath))
      return { plan: "unknown", source: "no_auth", fingerprint: "no_auth" };

    const auth = JSON.parse(readFileSyncFn(authPath, "utf8"));
    if (auth.auth_mode !== "chatgpt") {
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            auth_mode: auth.auth_mode || "api_key",
            has_api_key: Boolean(auth.api_key || auth.apiKey),
          }),
        )
        .digest("hex");
      return { plan: "api", source: "api_key", fingerprint };
    }

    const token = auth.tokens?.id_token || auth.tokens?.access_token;
    if (!token) {
      return {
        plan: "unknown",
        source: "no_token",
        fingerprint: createHash("sha256")
          .update(
            JSON.stringify({
              auth_mode: auth.auth_mode || "chatgpt",
              token: null,
            }),
          )
          .digest("hex"),
      };
    }

    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString(),
    );
    const plan =
      payload?.["https://api.openai.com/auth"]?.chatgpt_plan_type || "unknown";
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          auth_mode: auth.auth_mode || "chatgpt",
          plan,
          sub: payload?.sub || null,
          exp: payload?.exp || null,
        }),
      )
      .digest("hex");
    return { plan, source: "jwt", fingerprint };
  } catch {
    return { plan: "unknown", source: "error", fingerprint: "error" };
  }
}

export function detectCodexPlan(options = {}) {
  const { plan, source } = detectCodexAuthState(options);
  return { plan, source };
}
