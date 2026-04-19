// hub/lib/ssh-command.mjs — OS-aware SSH command builder
// PowerShell 호스트에 bash 문법(2>/dev/null, &&, $())을 보내는 사고를 방지한다.
// 모든 SSH 명령 생성 코드에서 이 유틸리티를 사용할 것.

import { readHosts } from "./hosts-compat.mjs";

/** hosts.json 캐시 (프로세스 수명 동안 유지) */
let hostsCache = null;
let hostsCacheRoot = null;

/**
 * hosts.json을 로드하여 캐시한다.
 * @param {string} [repoRoot] — 프로젝트 루트 경로
 */
function loadHostsCache(repoRoot) {
  const cacheKey = repoRoot || process.cwd();
  if (hostsCache && hostsCacheRoot === cacheKey) return;
  hostsCache = readHosts(repoRoot);
  hostsCacheRoot = cacheKey;
}

/**
 * hosts.json에서 호스트 OS를 조회한다.
 * @param {string} hostAlias — hosts.json의 키 (e.g. "ultra4")
 * @param {string} [repoRoot] — 프로젝트 루트 경로
 * @returns {"windows"|"posix"} 호스트 OS 유형
 */
export function detectHostOs(hostAlias, repoRoot) {
  loadHostsCache(repoRoot);

  const hostCfg = hostsCache.hosts?.[hostAlias];
  if (hostCfg?.os === "windows") return "windows";
  if (hostCfg?.os) return "posix";

  // IP 주소나 unknown alias → posix 기본값
  return "posix";
}

/**
 * OS에 맞는 셸 쿼팅을 적용한다.
 * - posix: 싱글쿼트 래핑 + 내부 싱글쿼트 이스케이프
 * - windows: PowerShell 싱글쿼트 래핑 + 내부 싱글쿼트 더블링
 * @param {string} value
 * @param {"windows"|"posix"} os
 * @returns {string}
 */
export function shellQuoteForHost(value, os) {
  const s = String(value);
  if (os === "windows") {
    // PowerShell: 싱글쿼트 내부에서 '' 로 이스케이프
    return `'${s.replace(/'/g, "''")}'`;
  }
  // POSIX: 싱글쿼트 내부에서 '\'' 로 이스케이프
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * OS에 맞는 stderr 억제 구문을 반환한다.
 * @param {"windows"|"posix"} os
 * @returns {string} "2>$null" 또는 "2>/dev/null"
 */
export function suppressStderr(os) {
  return os === "windows" ? "2>$null" : "2>/dev/null";
}

/**
 * OS에 맞는 명령 연결자를 반환한다.
 * @param {"windows"|"posix"} os
 * @returns {string} "; " (PowerShell) 또는 " && " (bash)
 */
export function commandJoin(os) {
  return os === "windows" ? "; " : " && ";
}

/**
 * OS에 맞는 null 디바이스 경로를 반환한다.
 * @param {"windows"|"posix"} os
 * @returns {string}
 */
export function nullDevice(os) {
  return os === "windows" ? "$null" : "/dev/null";
}

/**
 * SSH execFileSync 인자 배열을 안전하게 구성한다.
 * psmux 명령처럼 원격 셸에서 실행할 명령을 배열로 받아
 * 적절한 쿼팅을 적용한 SSH 인자 배열을 반환한다.
 *
 * @param {string} host — SSH 호스트 (user@ip 또는 alias)
 * @param {string[]} remoteCmd — 원격에서 실행할 명령 + 인자
 * @param {object} [opts]
 * @param {number} [opts.connectTimeout=5] — SSH 연결 타임아웃(초)
 * @param {boolean} [opts.keepalive=true] — ServerAliveInterval/CountMax 활성화
 * @param {"windows"|"posix"} [opts.os] — 호스트 OS (미지정 시 자동 감지)
 * @param {string} [opts.repoRoot] — hosts.json 탐색 경로
 * @returns {string[]} execFileSync('ssh', returnValue) 형태로 사용
 */
export function buildSshArgs(host, remoteCmd, opts = {}) {
  const connectTimeout = opts.connectTimeout ?? 5;
  const keepalive = opts.keepalive !== false;
  const hostAlias = host.includes("@") ? host.split("@").pop() : host;
  const os = opts.os ?? detectHostOs(hostAlias, opts.repoRoot);

  // 명령어(첫 요소)는 쿼팅하지 않고, 인자만 쿼팅
  const [cmd, ...args] = remoteCmd;
  const quotedArgs = args.map((a) => shellQuoteForHost(a, os));
  const remoteCmdStr = [cmd, ...quotedArgs].join(" ");

  const sshArgs = [
    "-o",
    `ConnectTimeout=${connectTimeout}`,
    "-o",
    "BatchMode=yes",
  ];

  if (keepalive) {
    sshArgs.push("-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3");
  }

  sshArgs.push(host, remoteCmdStr);
  return sshArgs;
}

/**
 * 검증: 문자열에 호스트 OS와 맞지 않는 셸 문법이 포함되었는지 검사한다.
 * SSH 명령 생성 시 안전 게이트로 사용.
 *
 * @param {string} command — 원격 실행할 명령 문자열
 * @param {"windows"|"posix"} os — 대상 호스트 OS
 * @returns {{ safe: boolean, violations: string[] }}
 */
export function validateCommandForOs(command, os) {
  const violations = [];

  if (os === "windows") {
    // PowerShell에서 해석 불가능한 bash 문법 검출
    if (/2>\/dev\/null/.test(command)) {
      violations.push("2>/dev/null → PowerShell에서는 2>$null 사용");
    }
    if (/\$\(/.test(command) && !/\$\(/.test(command) === false) {
      // $() bash substitution vs PowerShell $() — 문맥 의존
      // PowerShell도 $()를 사용하므로 여기선 경고만
    }
    if (/\s&&\s/.test(command)) {
      violations.push("&& → PowerShell에서는 ; 또는 -and 사용");
    }
    if (/\s\|\|\s/.test(command)) {
      violations.push("|| → PowerShell에서는 ; 또는 -or 사용");
    }
    if (/>\s*\/dev\/null/.test(command)) {
      violations.push(">/dev/null → PowerShell에서는 >$null 사용");
    }
  }

  return { safe: violations.length === 0, violations };
}

/**
 * hosts.json에서 호스트 전체 설정을 조회한다.
 * @param {string} hostAlias — hosts.json의 키 (e.g. "ultra4")
 * @param {string} [repoRoot]
 * @returns {object|null}
 */
export function getHostConfig(hostAlias, repoRoot) {
  loadHostsCache(repoRoot);
  return hostsCache.hosts?.[hostAlias] ?? null;
}

/**
 * 별칭(alias)으로 호스트 키를 찾는다.
 * @param {string} alias — 호스트 키 또는 aliases 배열 내 값
 * @param {string} [repoRoot]
 * @returns {string|null} 호스트 키 (e.g. "ultra4") 또는 null
 */
export function resolveHostAlias(alias, repoRoot) {
  loadHostsCache(repoRoot);

  if (hostsCache.hosts?.[alias]) return alias;

  for (const [name, cfg] of Object.entries(hostsCache.hosts || {})) {
    if (cfg.aliases.includes(alias)) return name;
  }

  return null;
}

/**
 * 특정 capability를 보유한 호스트 목록을 반환한다.
 * 명시적 선택 UI에서 바로 리소스 정보를 보여줄 수 있도록 specs를 평탄화한다.
 * @param {string} capability — e.g. "codex", "claude", "gpu"
 * @param {string} [repoRoot]
 * @returns {Array<{ name: string, config: object, specs: { cores?: number, ram_gb?: number } }>}
 */
export function selectHostForCapability(capability, repoRoot) {
  loadHostsCache(repoRoot);

  const matches = [];
  for (const [name, cfg] of Object.entries(hostsCache.hosts || {})) {
    if (cfg.capabilities?.includes(capability)) {
      matches.push({
        name,
        config: cfg,
        specs: {
          cores: cfg.specs?.cores,
          ram_gb: cfg.specs?.ram_gb,
        },
      });
    }
  }
  return matches;
}

/**
 * 특정 capability를 가진 호스트를 리소스 기준으로 정렬해 반환한다.
 * 자동 선택은 하지 않고, 명시적 선택 목록 정렬에만 사용한다.
 * @param {string} capability — e.g. "codex", "claude", "gpu"
 * @param {"cores"|"ram_gb"} sortBy
 * @param {string} [repoRoot]
 * @returns {Array<{ name: string, config: object, specs: { cores?: number, ram_gb?: number } }>}
 */
export function selectHostByResources(capability, sortBy, repoRoot) {
  if (sortBy !== "cores" && sortBy !== "ram_gb") {
    throw new TypeError('sortBy must be "cores" or "ram_gb"');
  }

  return selectHostForCapability(capability, repoRoot).sort((a, b) => {
    const aValue = a.specs?.[sortBy] ?? -Infinity;
    const bValue = b.specs?.[sortBy] ?? -Infinity;
    return bValue - aValue;
  });
}

/** hosts.json 캐시 초기화 (테스트용) */
export function resetHostsCache() {
  hostsCache = null;
  hostsCacheRoot = null;
}
