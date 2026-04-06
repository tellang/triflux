import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { get as httpGet } from "node:http";

const HUB_URL = "http://127.0.0.1:27888";
const AGENT_FILE_PREFIX = "tfx-agent-";
const AGENT_FILE_SUFFIX = ".json";

// 임시 디렉터리 경로를 플랫폼별 우선순위로 고른다.
function getTmpDir(env = process.env) {
  return env.TMPDIR || env.TEMP || "/tmp";
}

// 모니터가 읽을 에이전트 메타 파일만 고른다.
function isAgentFile(name) {
  return name.startsWith(AGENT_FILE_PREFIX) && name.endsWith(AGENT_FILE_SUFFIX);
}

// JSON 파싱 실패는 삼키고 null로 처리한다.
function readAgentRecord(filePath, deps) {
  try {
    return JSON.parse(deps.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

// PID 생존 여부를 확인한다.
// Windows에서 process.kill(pid, 0)이 불안정할 수 있으므로
// 24시간 이상 경과한 에이전트는 좀비로 간주한다.
const MAX_AGENT_AGE_S = 86400;

function isAlive(pid, deps, startedAt = 0) {
  const age = Math.floor(deps.now() / 1000) - (Number(startedAt) || 0);
  if (age > MAX_AGENT_AGE_S) return false;
  try {
    deps.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 좀비 파일 삭제 실패는 무시한다.
function removeZombie(filePath, deps) {
  try {
    deps.unlinkSync(filePath);
  } catch {}
}

// 표시용 경과 시간을 계산한다.
function toAgentView(record, now) {
  const started = Number(record.started) || 0;
  return {
    pid: Number(record.pid),
    cli: String(record.cli || ""),
    agent: String(record.agent || ""),
    started,
    elapsed: Math.max(0, now - started),
    alive: true,
  };
}

// /tmp/tfx-agent-*.json 파일에서 살아있는 에이전트 목록을 읽는다.
function pollAgents(deps = {}) {
  const resolved = {
    readdirSync,
    readFileSync,
    unlinkSync,
    kill: process.kill.bind(process),
    env: process.env,
    now: Date.now,
    ...deps,
  };
  const dir = getTmpDir(resolved.env);
  let names = [];

  try {
    names = resolved.readdirSync(dir).filter(isAgentFile);
  } catch {
    return [];
  }

  const now = Math.floor(resolved.now() / 1000);
  const agents = [];
  for (const name of names) {
    const filePath = join(dir, name);
    const record = readAgentRecord(filePath, resolved);
    if (!record) continue;
    if (!isAlive(Number(record.pid), resolved, record.started)) {
      removeZombie(filePath, resolved);
      continue;
    }
    agents.push(toAgentView(record, now));
  }
  return agents;
}

// hub /status 경로 URL을 안전하게 만든다.
function buildStatusUrl(hubUrl = HUB_URL) {
  return new URL("/status", hubUrl).toString();
}

// 응답 바디를 JSON으로 해석하고 핵심 필드만 추린다.
function parseStatus(body) {
  const parsed = JSON.parse(body);
  return {
    online: true,
    uptime: parsed.uptime,
    queueDepth: parsed.queueDepth,
    agents: parsed.agents,
  };
}

// node:http.get으로 허브 상태를 2초 안에 조회한다.
function fetchHubStatus(hubUrl = HUB_URL, deps = {}) {
  const get = deps.get || httpGet;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const req = get(buildStatusUrl(hubUrl), (res) => {
        let body = "";
        res.setEncoding?.("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          try {
            finish(res.statusCode === 200 ? parseStatus(body) : { online: false });
          } catch {
            finish({ online: false });
          }
        });
        res.on("error", () => finish({ online: false }));
      });

      req.setTimeout?.(2000, () => req.destroy(new Error("timeout")));
      req.on?.("error", () => finish({ online: false }));
    } catch {
      finish({ online: false });
    }
  });
}

export { pollAgents, fetchHubStatus };
