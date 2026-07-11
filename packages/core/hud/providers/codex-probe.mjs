// codex app-server account/rateLimits/read 능동 프로브 + 정규화.
// 세션 이벤트(snake_case) 파이프라인에 합류 가능한 스냅샷을 만든다.

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function readJwtExpSec(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf-8"),
    );
    return Number(payload.exp) || 0;
  } catch {
    return 0;
  }
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

const EXP_MARGIN_SEC = 600;

function accessTokenUsable(auth, nowMs) {
  const token = auth?.tokens?.access_token;
  if (!token) return false;
  const exp = readJwtExpSec(token);
  return exp > Math.floor(nowMs / 1000) + EXP_MARGIN_SEC;
}

export function recordProbe(stateFilePath, key, nowMs) {
  const state = readJsonFile(stateFilePath) || {};
  state[key] = nowMs;
  try {
    mkdirSync(dirname(stateFilePath), { recursive: true });
    writeFileSync(stateFilePath, JSON.stringify(state));
  } catch {
    // 상태 기록 실패는 무시 — 다음 사이클에 재시도
  }
}

export function listProbeTargets({
  codexAuthPath,
  brokerCacheDir,
  stateFilePath,
  ttlMs,
  nowMs,
}) {
  const state = readJsonFile(stateFilePath) || {};
  const due = (key) =>
    !(Number(state[key]) > 0 && nowMs - Number(state[key]) < ttlMs);
  const targets = [];

  const currentAuth = readJsonFile(codexAuthPath);
  if (currentAuth && accessTokenUsable(currentAuth, nowMs) && due("current")) {
    targets.push({ key: "current", codexHome: dirname(codexAuthPath) });
  }

  if (brokerCacheDir && existsSync(brokerCacheDir)) {
    let files = [];
    try {
      files = readdirSync(brokerCacheDir).filter((file) =>
        /^codex-auth-.+\.json$/.test(file),
      );
    } catch {
      files = [];
    }
    for (const file of files) {
      const key = file.replace(/^codex-auth-/, "").replace(/\.json$/, "");
      if (!due(key)) continue;
      const auth = readJsonFile(join(brokerCacheDir, file));
      if (!auth || !accessTokenUsable(auth, nowMs)) continue;
      const home = mkdtempSync(join(tmpdir(), `tfx-probe-home-${key}-`));
      writeFileSync(join(home, "auth.json"), JSON.stringify(auth));
      targets.push({ key, codexHome: home });
    }
  }
  return targets;
}

function toSnakeBucket(bucket) {
  if (!bucket) return null;
  return {
    used_percent: bucket.usedPercent ?? null,
    window_minutes: bucket.windowDurationMins ?? null,
    resets_at: bucket.resetsAt ?? null,
  };
}

function toSnapshot(entry, nowIso) {
  return {
    limitId: entry.limitId,
    limitName: entry.limitName ?? null,
    primary: toSnakeBucket(entry.primary),
    secondary: toSnakeBucket(entry.secondary),
    credits: entry.credits ?? null,
    tokens: null,
    contextWindow: null,
    timestamp: nowIso,
    probe: true,
  };
}

export function normalizeAppServerRateLimits(result, nowIso) {
  if (!result) return [];
  const byId = result.rateLimitsByLimitId;
  if (byId && typeof byId === "object" && Object.keys(byId).length > 0) {
    return Object.values(byId)
      .filter((e) => e?.limitId)
      .map((e) => toSnapshot(e, nowIso));
  }
  if (result.rateLimits?.limitId) {
    return [toSnapshot(result.rateLimits, nowIso)];
  }
  return [];
}

export function probeRateLimitsViaAppServer({
  codexHome = null,
  spawnBin = "codex",
  spawnArgs = ["app-server"],
  timeoutMs = 10000,
  now = new Date(),
} = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(spawnBin, spawnArgs, {
        stdio: ["pipe", "pipe", "ignore"],
        env: codexHome
          ? { ...process.env, CODEX_HOME: codexHome }
          : process.env,
      });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    let buf = "";
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // 이미 종료
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const send = (obj) => {
      try {
        child.stdin.write(`${JSON.stringify(obj)}\n`);
      } catch {
        finish(null);
      }
    };
    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));
    child.stdout.on("data", (data) => {
      buf += data.toString();
      let idx = buf.indexOf("\n");
      while (idx >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        idx = buf.indexOf("\n");
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1 && msg.result) {
          send({
            jsonrpc: "2.0",
            id: 2,
            method: "account/rateLimits/read",
            params: {},
          });
        } else if (msg.id === 2) {
          if (msg.error) finish(null);
          else {
            finish(normalizeAppServerRateLimits(msg.result, now.toISOString()));
          }
        }
      }
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "triflux-hud-probe",
          title: "triflux HUD quota probe",
          version: "1.0.0",
        },
      },
    });
  });
}
