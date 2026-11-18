#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  argv,
  exit,
  platform as hostPlatform,
  pid,
  env as processEnv,
  stdin,
  stdout,
} from "node:process";
import { pathToFileURL } from "node:url";

const SAFE_CONVERSATION_ID = /^[0-9a-zA-Z._-]+$/;
const PRESSURE_LABELS = {
  2: "warn(2)",
  4: "critical(4)",
};

function parsePayload(stdinData) {
  if (stdinData && typeof stdinData === "object" && !Array.isArray(stdinData)) {
    return stdinData;
  }
  try {
    const raw = typeof stdinData === "string" ? stdinData.trim() : "";
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function normalizeMode(rawMode, payload) {
  const direct = String(rawMode || "")
    .trim()
    .toLowerCase();
  if (direct === "start" || direct === "pre" || direct === "stop") {
    return direct;
  }
  const eventName = String(
    payload?.hookEventName || payload?.hook_event_name || "",
  )
    .trim()
    .toLowerCase()
    .replace(/[-_]/g, "");
  if (eventName === "sessionstart") return "start";
  if (eventName === "preinvocation") return "pre";
  if (eventName === "stop") return "stop";
  return "";
}

function resolveStateRoot(env, opts = {}) {
  if (opts.stateRoot) return opts.stateRoot;
  const base =
    env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state");
  return join(base, "triflux");
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmpPath, filePath);
}

function isActiveLeadRecord(record) {
  return (
    Boolean(record) &&
    typeof record === "object" &&
    (record.sessionRole === "lead" || record.sessionRole === "communication")
  );
}

function loadActiveLeadMarkers(stateRoot) {
  const dir = join(stateRoot, "lead-roles");
  if (!existsSync(dir)) return [];
  let names = [];
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    const filePath = join(dir, name);
    const record = readJsonSafe(filePath);
    if (isActiveLeadRecord(record)) {
      entries.push({
        filePath,
        markerName: basename(name, ".json"),
        record,
      });
    }
  }
  return entries;
}

function defaultResolvePaneSession(paneId, env) {
  if (!env?.TMUX || env?.TRIFLUX_TEST_HOME || env?.TEST_LOCK_PID) {
    return undefined;
  }
  try {
    const out = execFileSync(
      "tmux",
      ["display-message", "-p", "-t", paneId, "#{session_name}"],
      {
        env,
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return String(out || "").trim() || null;
  } catch {
    return null;
  }
}

function findMatchingLeadMarker(stateRoot, payload, env, opts = {}) {
  const entries = loadActiveLeadMarkers(stateRoot);
  if (entries.length === 0) return null;

  const pruned = new Set();
  const resolvePaneSession =
    opts.resolvePaneSession || defaultResolvePaneSession;
  const paneId = String(env.TMUX_PANE || "").trim();
  if (paneId) {
    let liveSession;
    for (const entry of entries) {
      if (entry.record.paneId !== paneId) continue;
      if (liveSession === undefined) {
        liveSession = resolvePaneSession(paneId, env);
      }
      if (
        liveSession === null ||
        (liveSession !== undefined &&
          entry.record.session &&
          liveSession !== entry.record.session)
      ) {
        pruned.add(entry.filePath);
        try {
          rmSync(entry.filePath, { force: true });
        } catch {}
        continue;
      }
      return entry;
    }
  }

  const activeEntries = pruned.size
    ? entries.filter((entry) => !pruned.has(entry.filePath))
    : entries;

  const conversationId = String(payload?.conversationId || "").trim();
  if (conversationId) {
    const byConversation = activeEntries.find(
      (entry) => entry.record.conversationId === conversationId,
    );
    if (byConversation) return byConversation;
  }

  return null;
}

function defaultReadPressureLevel() {
  return execFileSync("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], {
    encoding: "utf8",
    timeout: 2000,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export async function runAgyLeadHook(stdinData, opts = {}) {
  const env = opts.env || processEnv;
  const payload = parsePayload(stdinData);
  const mode = normalizeMode(opts.mode ?? opts.argvMode ?? argv[2], payload);
  const stateRoot = resolveStateRoot(env, opts);
  const finish = (response) => {
    if (opts.writeStdout) {
      stdout.write(`${JSON.stringify(response)}\n`);
    }
    return response;
  };

  try {
    if (mode === "stop") {
      if (
        payload.continuationActive === true ||
        payload.fullyIdle === false ||
        (payload.terminationReason &&
          payload.terminationReason !== "NO_TOOL_CALL")
      ) {
        return finish({ decision: "allow" });
      }
    }

    const active = findMatchingLeadMarker(stateRoot, payload, env, opts);
    let markerDirty = false;
    const conversationId =
      typeof payload.conversationId === "string"
        ? payload.conversationId.trim()
        : "";

    if (
      active &&
      conversationId &&
      active.record.conversationId !== conversationId
    ) {
      active.record.conversationId = conversationId;
      markerDirty = true;
    }

    if (mode === "start") {
      if (!active) return finish({});
      const handoffPath =
        typeof active.record.pendingHandoff?.path === "string"
          ? active.record.pendingHandoff.path.trim()
          : "";
      if (handoffPath) {
        active.record.pendingHandoff = null;
        writeJsonAtomic(active.filePath, active.record);
        return finish({
          injectSteps: [
            {
              systemMessage: {
                systemMessage: `[tfx-lead] 인계 파일 ${handoffPath} 를 읽고 역할을 이어간다.`,
              },
            },
          ],
        });
      }
      if (markerDirty) {
        writeJsonAtomic(active.filePath, active.record);
      }
      return finish({});
    }

    if (mode === "pre") {
      if (active && markerDirty) {
        writeJsonAtomic(active.filePath, active.record);
      }
      if (!active || (opts.platform ?? hostPlatform) !== "darwin") {
        return finish({});
      }
      const readPressure = opts.readPressureLevel || defaultReadPressureLevel;
      const rawLevel = await readPressure();
      const level = Number(String(rawLevel ?? "").trim());
      if (level !== 1 && level !== 2 && level !== 4) {
        return finish({});
      }
      const rawKey =
        active.record.session ||
        active.record.paneId ||
        conversationId ||
        active.markerName ||
        "default";
      const safeKey = String(rawKey).replace(/[^a-zA-Z0-9._-]/g, "_");
      const pressurePath = join(stateRoot, "pressure", `agy-${safeKey}.json`);
      const prevState = existsSync(pressurePath)
        ? readJsonSafe(pressurePath)
        : null;
      const prevLevel = Number(prevState?.level);
      if (prevLevel !== level) {
        writeJsonAtomic(pressurePath, {
          level,
          updatedAt: new Date().toISOString(),
        });
        const label = PRESSURE_LABELS[level];
        if (label) {
          return finish({
            injectSteps: [
              {
                systemMessage: {
                  systemMessage: `[tfx-pressure] macOS 메모리 압박 단계가 ${label}로 바뀌었다. 새 워커 생성을 줄이고 끝난 워커를 닫아라.`,
                },
              },
            ],
            terminationBehavior: "",
          });
        }
      }
      return finish({});
    }

    if (mode === "stop") {
      if (!active) return finish({ decision: "allow" });
      if (conversationId && SAFE_CONVERSATION_ID.test(conversationId)) {
        const contextPath = join(
          stateRoot,
          "agy-context",
          `${conversationId}.json`,
        );
        const contextRecord = existsSync(contextPath)
          ? readJsonSafe(contextPath)
          : null;
        const usedPercentage = Number(contextRecord?.usedPercentage);
        if (
          Number.isFinite(usedPercentage) &&
          usedPercentage >= 85 &&
          active.record.notifiedConversationId !== conversationId
        ) {
          active.record.notifiedConversationId = conversationId;
          active.record.notifiedThreshold = 85;
          writeJsonAtomic(active.filePath, active.record);
          return finish({
            decision: "continue",
            reason: `[tfx-lead] 컨텍스트 사용량이 ${Math.round(usedPercentage)}%에 도달했다. 인계 파일을 저장하고 tfx-live clear 로 세션을 승계하라.`,
          });
        }
      }
      if (markerDirty) {
        writeJsonAtomic(active.filePath, active.record);
      }
      return finish({ decision: "allow" });
    }

    if (active && markerDirty) {
      writeJsonAtomic(active.filePath, active.record);
    }
    return finish({});
  } catch {
    return finish(mode === "stop" ? { decision: "allow" } : {});
  }
}

function readStdin() {
  return new Promise((resolvePromise) => {
    let data = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => {
      data += chunk;
    });
    stdin.on("end", () => resolvePromise(data));
    stdin.on("error", () => resolvePromise(data));
  });
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  const stdinData = await readStdin();
  await runAgyLeadHook(stdinData, { writeStdout: true });
  exit(0);
}
