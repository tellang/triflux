// ============================================================================
// 상수 / 경로
// ============================================================================
import { homedir } from "node:os";
import { join } from "node:path";

export const VERSION = "2.0";

export const ACCOUNTS_CONFIG_PATH = join(
  homedir(),
  ".claude",
  "cache",
  "tfx-hub",
  "accounts.json",
);
export const ACCOUNTS_STATE_PATH = join(
  homedir(),
  ".claude",
  "cache",
  "tfx-hub",
  "cli_accounts_state.json",
);

// triflux-mods 의 Claude band 가 세션마다 갱신하는 표식. 있으면 Claude 행을 뺀다.
export const CLAUDE_BAND_MARKER_DIR = join(
  homedir(),
  ".claude",
  "cache",
  "triflux",
  "claude-band",
);
export const CLAUDE_BAND_MARKER_TTL_MS = 12 * 60 * 60 * 1000;

export const CONTEXT_MONITOR_CACHE_PATH = join(
  homedir(),
  ".claude",
  "cache",
  "tfx-hub",
  "context-monitor.json",
);
export const HUB_REQUEST_MONITOR_CACHE_PATH = join(
  homedir(),
  ".claude",
  "cache",
  "tfx-hub",
  "hub-request-context-monitor.json",
);
export const CONTEXT_MONITOR_LOG_DIR = join(
  homedir(),
  ".claude",
  "cache",
  "tfx-hub",
  "logs",
);

// Claude OAuth Usage API (api.anthropic.com/api/oauth/usage)
export const CLAUDE_CREDENTIALS_PATH = join(
  homedir(),
  ".claude",
  ".credentials.json",
);
export const CLAUDE_CREDENTIALS_FILENAME = ".credentials.json";
export const CLAUDE_CODE_USER_AGENT_FALLBACK = "claude-code/2.x";
// Claude Code 2.1.x 평문 폴백 파일 위치: CLAUDE_SECURESTORAGE_CONFIG_DIR 가 정의돼 있으면 그 디렉터리
// (빈 문자열은 기본 ~/.claude), 아니면 CLAUDE_CONFIG_DIR. 기본 경로는 항상 마지막 후보로 둔다.
export function getClaudeCredentialPaths(env = process.env) {
  const paths = [];
  const secureDir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (secureDir !== undefined) {
    if (secureDir) {
      paths.push(join(secureDir.normalize("NFC"), CLAUDE_CREDENTIALS_FILENAME));
    }
  } else if (env.CLAUDE_CONFIG_DIR) {
    paths.push(join(env.CLAUDE_CONFIG_DIR, CLAUDE_CREDENTIALS_FILENAME));
  }
  if (paths[0] !== CLAUDE_CREDENTIALS_PATH) paths.push(CLAUDE_CREDENTIALS_PATH);
  return paths;
}
export function getClaudeCodeUserAgent(env = process.env) {
  return env.CLAUDE_CODE_VERSION
    ? `claude-code/${env.CLAUDE_CODE_VERSION}`
    : CLAUDE_CODE_USER_AGENT_FALLBACK;
}
export const CLAUDE_USAGE_CACHE_PATH = join(
  homedir(),
  ".claude",
  "cache",
  "claude-usage-cache.json",
);
export const OMC_PLUGIN_USAGE_CACHE_PATH = join(
  homedir(),
  ".claude",
  "cache",
  "tfx-hub",
  "plugin-usage-cache.json",
);
export const CLAUDE_USAGE_STALE_MS_SOLO = 5 * 60 * 1000; // OMC 없을 때: 5분 캐시
export const CLAUDE_USAGE_STALE_MS_WITH_OMC = 15 * 60 * 1000; // OMC 있을 때: 15분
export const CLAUDE_USAGE_429_BACKOFF_MS = 10 * 60 * 1000; // 429 에러 시 10분 backoff
export const GEMINI_429_BASE_DELAY_MS = 2000;
export const GEMINI_429_MAX_RETRIES = 3;
export const GEMINI_429_COOLDOWN_MS = 30000;
export const CLAUDE_USAGE_ERROR_BACKOFF_MS = 3 * 60 * 1000; // 기타 에러 시 3분 backoff
export const CLAUDE_API_TIMEOUT_MS = 10_000;
export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
export const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;
export const ONE_DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

// Codex CLI 는 CODEX_HOME 이 있으면 그 디렉터리를 쓴다. 호출 시점에 읽어 환경 변화를 따른다.
export function getCodexHome() {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}
export function getCodexAuthPath() {
  return join(getCodexHome(), "auth.json");
}
export const CODEX_PROBE_STATE_PATH = join(
  homedir(),
  ".claude",
  "cache",
  "codex-probe-state.json",
);
export const CODEX_PROBE_TTL_MS = 5 * 60 * 1000;
export const CODEX_PROBE_TIMEOUT_MS = 10_000;
export const CODEX_QUOTA_CACHE_PATH = join(
  homedir(),
  ".claude",
  "cache",
  "codex-rate-limits-cache.json",
);
export const CODEX_QUOTA_STALE_MS = 30 * 1000; // 30초
export const CODEX_MIN_BUCKETS = 2;

// Spawn lock (중복 refresh 방지)
export const CLAUDE_REFRESH_LOCK_PATH = join(
  homedir(),
  ".claude",
  "cache",
  ".claude-refresh-lock",
);
export const CODEX_REFRESH_LOCK_PATH = join(
  homedir(),
  ".claude",
  "cache",
  ".codex-refresh-lock",
);
export const SPAWN_LOCK_TTL_MS = 30 * 1000; // 30초 spawn dedup

export const ANTIGRAVITY_OAUTH_PATHS = [
  join(homedir(), ".gemini", "antigravity-cli", "oauth_creds.json"),
  join(homedir(), ".gemini", "antigravity-cli", "credentials.json"),
];
export const ANTIGRAVITY_KEYCHAIN_SERVICE = "gemini";
export const ANTIGRAVITY_KEYCHAIN_ACCOUNT = "antigravity";
export const ANTIGRAVITY_SETTINGS_PATH = join(
  homedir(),
  ".gemini",
  "antigravity-cli",
  "settings.json",
);
export const ANTIGRAVITY_QUOTA_CACHE_PATH = join(
  homedir(),
  ".claude",
  "cache",
  "antigravity-quota-cache.json",
);
export const ANTIGRAVITY_REFRESH_LOCK_PATH = join(
  homedir(),
  ".claude",
  "cache",
  ".antigravity-refresh-lock",
);
export const ANTIGRAVITY_QUOTA_STALE_MS = 5 * 60 * 1000;
// 조회가 잠시 실패해도 이 시간 안에 성공한 적이 있으면 로그인 상태로 본다.
export const ANTIGRAVITY_SIGNED_IN_GRACE_MS = 60 * 60 * 1000;
export const ANTIGRAVITY_REFRESH_FLAG = "--refresh-antigravity-quota";
export const ACCOUNT_LABEL_WIDTH = 10;
export const PROVIDER_PREFIX_WIDTH = 2;
export const PERCENT_CELL_WIDTH = 4;
export const TIME_CELL_INNER_WIDTH = 6;

export const CLAUDE_REFRESH_FLAG = "--refresh-claude-usage";
export const CODEX_REFRESH_FLAG = "--refresh-codex-rate-limits";

// 모바일/Termux 컴팩트 모드 감지
export const HUD_CONFIG_PATH = join(homedir(), ".omc", "config", "hud.json");
export const COMPACT_COLS_THRESHOLD = 80;
export const MINIMAL_COLS_THRESHOLD = 60;
