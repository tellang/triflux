// scripts/lib/mcp-gateway-health-check.mjs
//
// `~/.local/state/triflux/mcp-gateway.out.log` 파싱 헬퍼.
// install-mcp-gateway-startup.mjs 가 LaunchAgent/systemd 로 띄운 gateway daemon
// (mcp-gateway-start.mjs) 의 stdout 로그에서 다음 신호를 추출한다.
//
//   [WARN] <server> skipped — missing env: <KEY>   → missing-env finding
//   [START] <server> on :<port>                    → started
//   [SKIP]  <server> already running on :<port>    → started (preExisting)
//   [SKIP]  <server> — manifest에서 비활성         → manifest-disabled skip
//
// 호출자는 `findings` 만 보고 doctor 진단을 출력할 수 있다.
// log 파일이 없으면 `available: false` 로 반환하므로, gateway 미설치 환경에서는
// 침묵한다 (false-positive 방지).

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_LOG_PATH = join(
  homedir(),
  ".local",
  "state",
  "triflux",
  "mcp-gateway.out.log",
);

// producer (scripts/mcp-gateway-start.mjs:146) 가 missing env 를 `missing.join(", ")`
// 로 출력하므로 detail 은 공백 포함 다중 키 (예: "JIRA_API_TOKEN, JIRA_EMAIL, JIRA_INSTANCE_URL")
// 일 수 있다. line 끝까지 캡처한다.
const MISSING_ENV_RE = /^\[WARN\]\s+(\S+)\s+skipped\s+—\s+missing env:\s+(.+)$/;
const START_RE = /^\[START\]\s+(\S+)\s+on\s+:(\d+)$/;
const SKIP_RUNNING_RE = /^\[SKIP\]\s+(\S+)\s+already running on\s+:(\d+)$/;
const SKIP_DISABLED_RE = /^\[SKIP\]\s+(\S+)\s+—\s+manifest에서 비활성$/;

export function checkMcpGatewayHealth({
  fs = { readFileSync, statSync },
  logPath = DEFAULT_LOG_PATH,
} = {}) {
  try {
    fs.statSync(logPath);
  } catch {
    return {
      available: false,
      logPath,
      findings: [],
      started: [],
      skipped: [],
    };
  }

  let text;
  try {
    text = fs.readFileSync(logPath, "utf8");
  } catch (error) {
    return {
      available: true,
      logPath,
      findings: [
        {
          server: null,
          reason: "log-read-error",
          detail: error?.message || String(error),
        },
      ],
      started: [],
      skipped: [],
    };
  }

  // log 는 append-only 라 옛 [WARN] 라인 뒤에 새 [START] 라인이 올 수 있다.
  // server 별 마지막 이벤트가 현재 상태이므로 그것만 finding 으로 환원한다.
  // (예: BRAVE_API_KEY missing 으로 한 번 skip → secrets 추가 후 restart 로 start)
  const lastEvent = new Map();

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    let m;
    if ((m = MISSING_ENV_RE.exec(line))) {
      lastEvent.set(m[1], {
        type: "missing-env",
        detail: m[2],
      });
      continue;
    }
    if ((m = START_RE.exec(line))) {
      lastEvent.set(m[1], {
        type: "started",
        port: Number(m[2]),
        preExisting: false,
      });
      continue;
    }
    if ((m = SKIP_RUNNING_RE.exec(line))) {
      lastEvent.set(m[1], {
        type: "started",
        port: Number(m[2]),
        preExisting: true,
      });
      continue;
    }
    if ((m = SKIP_DISABLED_RE.exec(line))) {
      lastEvent.set(m[1], {
        type: "manifest-disabled",
      });
      continue;
    }
  }

  const findings = [];
  const started = [];
  const skipped = [];
  for (const [server, ev] of lastEvent) {
    if (ev.type === "missing-env") {
      findings.push({ server, reason: "missing-env", detail: ev.detail });
    } else if (ev.type === "started") {
      started.push({ server, port: ev.port, preExisting: ev.preExisting });
    } else if (ev.type === "manifest-disabled") {
      skipped.push({ server, reason: "manifest-disabled" });
    }
  }

  return {
    available: true,
    logPath,
    findings,
    started,
    skipped,
  };
}

export function summarizeMcpGatewayHealth(result) {
  if (!result?.available) {
    return {
      level: "skip",
      message: "mcp-gateway log 없음 (gateway 미설치 또는 미실행)",
    };
  }
  if (result.findings.length === 0) {
    return {
      level: "ok",
      message: `mcp-gateway healthy (${result.started.length}개 server up)`,
    };
  }
  const missingEnv = result.findings.filter((f) => f.reason === "missing-env");
  if (missingEnv.length > 0) {
    const list = missingEnv
      .map((f) => `${f.server} (${f.detail})`)
      .join(", ");
    return {
      level: "warn",
      message: `${missingEnv.length}개 MCP 서버가 missing env 로 skip: ${list}`,
      fix: "secrets 를 ~/.config/triflux/secrets.env 에 추가하고 `launchctl kickstart -k gui/$(id -u)/com.tellang.mcp-gateway` (macOS) 또는 `systemctl --user restart mcp-gateway` (linux)",
    };
  }
  return {
    level: "warn",
    message: `${result.findings.length}개 gateway 이슈`,
  };
}
