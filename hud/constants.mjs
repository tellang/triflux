// ============================================================================
// 상수 / 경로
// ============================================================================
import { homedir } from "node:os";
import { join } from "node:path";

export const VERSION = "2.0";

export const QOS_PATH = join(homedir(), ".omc", "state", "cli_qos_profile.json");
export const ACCOUNTS_CONFIG_PATH = join(homedir(), ".omc", "router", "accounts.json");
export const ACCOUNTS_STATE_PATH = join(homedir(), ".omc", "state", "cli_accounts_state.json");

// tfx-multi 상태 (v2.2 HUD 통합)
export const TEAM_STATE_PATH = join(homedir(), ".claude", "cache", "tfx-hub", "team-state.json");

// Claude OAuth Usage API (api.anthropic.com/api/oauth/usage)
export const CLAUDE_CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
export const CLAUDE_USAGE_CACHE_PATH = join(homedir(), ".claude", "cache", "claude-usage-cache.json");
export const OMC_PLUGIN_USAGE_CACHE_PATH = join(homedir(), ".claude", "plugins", "oh-my-claudecode", ".usage-cache.json");
export const CLAUDE_USAGE_STALE_MS_SOLO = 5 * 60 * 1000; // OMC 없을 때: 5분 캐시
export const CLAUDE_USAGE_STALE_MS_WITH_OMC = 15 * 60 * 1000; // OMC 있을 때: 15분 (OMC가 30초마다 갱신)
export const CLAUDE_USAGE_429_BACKOFF_MS = 10 * 60 * 1000; // 429 에러 시 10분 backoff
export const CLAUDE_USAGE_ERROR_BACKOFF_MS = 3 * 60 * 1000; // 기타 에러 시 3분 backoff
export const CLAUDE_API_TIMEOUT_MS = 10_000;
export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
export const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;
export const ONE_DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export const CODEX_AUTH_PATH = join(homedir(), ".codex", "auth.json");
export const CODEX_QUOTA_CACHE_PATH = join(homedir(), ".claude", "cache", "codex-rate-limits-cache.json");
export const CODEX_QUOTA_STALE_MS = 15 * 1000; // 15초
export const CODEX_MIN_BUCKETS = 2;

// Gemini 쿼터 API 관련
export const GEMINI_OAUTH_PATH = join(homedir(), ".gemini", "oauth_creds.json");
export const GEMINI_QUOTA_CACHE_PATH = join(homedir(), ".claude", "cache", "gemini-quota-cache.json");
export const GEMINI_PROJECT_CACHE_PATH = join(homedir(), ".claude", "cache", "gemini-project-id.json");
export const GEMINI_SESSION_CACHE_PATH = join(homedir(), ".claude", "cache", "gemini-session-cache.json");
export const GEMINI_RPM_TRACKER_PATH = join(homedir(), ".claude", "cache", "gemini-rpm-tracker.json");
export const SV_ACCUMULATOR_PATH = join(homedir(), ".claude", "cache", "sv-accumulator.json");
// 이전 .omc/ 경로 fallback (기존 환경 호환)
export const LEGACY_GEMINI_QUOTA_CACHE = join(homedir(), ".omc", "state", "gemini_quota_cache.json");
export const LEGACY_GEMINI_PROJECT_CACHE = join(homedir(), ".omc", "state", "gemini_project_id.json");
export const LEGACY_GEMINI_SESSION_CACHE = join(homedir(), ".omc", "state", "gemini_session_tokens_cache.json");
export const LEGACY_GEMINI_RPM_TRACKER = join(homedir(), ".omc", "state", "gemini_rpm_tracker.json");
export const LEGACY_SV_ACCUMULATOR = join(homedir(), ".omc", "state", "sv-accumulator.json");

export const GEMINI_RPM_WINDOW_MS = 60 * 1000; // 60초 슬라이딩 윈도우
export const GEMINI_QUOTA_STALE_MS = 5 * 60 * 1000; // 5분
export const GEMINI_SESSION_STALE_MS = 15 * 1000; // 15초
export const GEMINI_API_TIMEOUT_MS = 3000; // 3초

export const ACCOUNT_LABEL_WIDTH = 10;
export const PROVIDER_PREFIX_WIDTH = 2;
export const PERCENT_CELL_WIDTH = 3;
export const TIME_CELL_INNER_WIDTH = 6;
export const SV_CELL_WIDTH = 5;

export const CLAUDE_REFRESH_FLAG = "--refresh-claude-usage";
export const CODEX_REFRESH_FLAG = "--refresh-codex-rate-limits";
export const GEMINI_REFRESH_FLAG = "--refresh-gemini-quota";
export const GEMINI_SESSION_REFRESH_FLAG = "--refresh-gemini-session";

// 모바일/Termux 컴팩트 모드 감지
export const HUD_CONFIG_PATH = join(homedir(), ".omc", "config", "hud.json");
export const COMPACT_COLS_THRESHOLD = 80;
export const MINIMAL_COLS_THRESHOLD = 60;

// rows 임계값 상수 (selectTier 에서 tier 결정에 사용)
export const ROWS_BUDGET_FULL = 40;
export const ROWS_BUDGET_LARGE = 35;
export const ROWS_BUDGET_MEDIUM = 28;
export const ROWS_BUDGET_SMALL = 22;

// Gemini Pro 풀 공유 그룹: 같은 remainingFraction을 공유하는 모델 ID들
export const GEMINI_PRO_POOL = new Set(["gemini-2.5-pro", "gemini-3-pro-preview", "gemini-3.1-pro-preview"]);
export const GEMINI_FLASH_POOL = new Set(["gemini-2.5-flash", "gemini-3-flash-preview"]);
