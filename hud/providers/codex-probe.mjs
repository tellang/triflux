// codex app-server account/rateLimits/read 능동 프로브 + 정규화.
// 세션 이벤트(snake_case) 파이프라인에 합류 가능한 스냅샷을 만든다.

import { spawn } from "node:child_process";

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
      .filter((e) => e && e.limitId)
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
            finish(
              normalizeAppServerRateLimits(msg.result, now.toISOString()),
            );
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
