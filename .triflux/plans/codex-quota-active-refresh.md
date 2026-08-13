# Codex Quota Active Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HUD codex 5h/1w quota를 세션 이벤트 수동 수집에만 의존하지 않고, codex app-server의 `account/rateLimits/read` JSON-RPC(모델 토큰 0 소모)로 주기적으로 능동 갱신한다.

**Architecture:** 새 prober 모듈(`hud/providers/codex-probe.mjs`)이 `codex app-server`를 stdio로 스폰해 initialize → `account/rateLimits/read`를 호출하고, 응답(camelCase)을 기존 세션 스냅샷 shape(snake_case)로 정규화한다. `refreshCodexRateLimitsCache()`가 passive 세션 스캔에 probe 스냅샷을 `extraSnapshots`로 합류시켜 기존 창 선택 파이프라인(90s 클러스터 + max-used)을 그대로 태운다. 트리거는 기존 statusline 갱신 스폰 경로를 재사용(hub 데몬 무관 — cto-hub 경계 준수), 계정별 TTL 스로틀로 비용 상한.

**Tech Stack:** Node ESM(.mjs), node:child_process spawn, JSON-RPC 2.0 over stdio, node:test 기반 기존 테스트 스위트.

## 사전 확정 사실 (2026-07-11 스파이크 실측)

- `codex app-server`(0.144.1, stdio)는 `initialize`(params: `{clientInfo:{name,title,version}}`) 후 `account/rateLimits/read`(params: `{}`)에 즉시 응답. 소요 ~1-2s, 모델 토큰 0.
- 응답 shape (실측 캡처):
  ```json
  {"id":2,"result":{
    "rateLimits":{"limitId":"codex","limitName":null,
      "primary":{"usedPercent":45,"windowDurationMins":300,"resetsAt":1783767909},
      "secondary":{"usedPercent":7,"windowDurationMins":10080,"resetsAt":1784354709},
      "credits":{"hasCredits":false,"unlimited":false,"balance":"0"},
      "individualLimit":null,"planType":"pro","rateLimitReachedType":null},
    "rateLimitsByLimitId":{"codex":{...같은 shape...},"codex_bengalfox":{...}}}}
  ```
- 세션 이벤트/기존 캐시 shape는 snake_case: `used_percent`, `window_minutes`, `resets_at`. **camelCase→snake_case 매핑이 정규화의 핵심.**
- CODEX_HOME 환경변수로 auth 디렉토리 지정 가능(initialize 응답이 `codexHome` 에코). 브로커 계정 캐시: `~/.claude/cache/tfx-hub/codex-auth-*.json` (auth.json 전체 사본).
- 기존 파이프라인 진입점: `hud/providers/codex.mjs`의 `getCodexRateLimits()`(스냅샷 병합·선택), `refreshCodexRateLimitsCache()`(캐시 기록), `scheduleCodexRateLimitRefresh()`(statusline이 detached 스폰, 30s 스폰락 기존재).

## Global Constraints

- 커밋에 AI trailer / Co-Authored-By / 이름 표기 금지.
- 미러 정책(`.claude/rules/tfx-mirror-policy.md`): `hud/*` 변경은 `packages/core/hud/`, `packages/triflux/hud/`에 byte-identical cp + `diff -q` 검증. 사용자 트윈 `~/.claude/hud/`에도 cp + `diff -q`.
- lint는 변경 파일 한정(repo-wide 포맷 금지).
- **probe는 절대 토큰 refresh를 강제하지 않는다** — access token 만료 임박(<10분) 계정은 skip. auth 파일에 어떤 write도 하지 않는다(#78 refresh_token_reused 재발 방지).
- hub 데몬을 재시작하거나 hub에 주기 작업을 추가하지 않는다(트리거는 HUD refresh 경로 한정).
- 기존 캐시 계약(`~/.claude/cache/codex-rate-limits-cache.json`의 buckets shape) 불변.
- 선행 조건: 진행 중인 stale-렌더-제거 커밋(브리프 `.omc/context/hud-fix-20260711/brief-stale-color.md`)이 main에 먼저 랜드된 뒤 시작(같은 미러/테스트 파일 충돌 방지).
- 실행 CLI: Codex (default 정책).

## File Structure

- Create: `hud/providers/codex-probe.mjs` — app-server JSON-RPC 클라이언트 + 응답 정규화 + 계정 열거/스로틀. 외부 의존은 node 내장만.
- Modify: `hud/providers/codex.mjs` — `getCodexRateLimits({extraSnapshots})` 파라미터 추가(병합 합류점), `refreshCodexRateLimitsCache()`에서 probe 호출.
- Modify: `hud/constants.mjs` — probe 상수(TTL, 타임아웃, 상태파일 경로, env 게이트 키).
- Test: `tests/unit/hud-codex-probe.test.mjs` (신규), `tests/unit/hud-codex-bucket.test.mjs` (extraSnapshots 합류 케이스 추가).
- Mirror: 위 hud 파일들의 packages/{core,triflux} + `~/.claude/hud` 트윈.

---

### Task 1: 응답 정규화기 `normalizeAppServerRateLimits`

**Files:**
- Create: `hud/providers/codex-probe.mjs`
- Test: `tests/unit/hud-codex-probe.test.mjs`

**Interfaces:**
- Produces: `normalizeAppServerRateLimits(result, nowIso)` → `Array<Snapshot>`; Snapshot = `{limitId, limitName, primary|null, secondary|null, credits, tokens: null, contextWindow: null, timestamp: nowIso, probe: true}`; primary/secondary는 snake_case 버킷 `{used_percent, window_minutes, resets_at}`. `rateLimitsByLimitId`의 모든 엔트리를 각각 스냅샷으로 변환하고, 그 안에 `codex` 키가 없으면 top-level `rateLimits`를 폴백으로 1건 변환.

- [ ] **Step 1: 실패하는 테스트 작성** — 스파이크 실측 fixture 그대로 사용

```js
// tests/unit/hud-codex-probe.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAppServerRateLimits } from "../../hud/providers/codex-probe.mjs";

const FIXTURE = {
  rateLimits: {
    limitId: "codex", limitName: null,
    primary: { usedPercent: 45, windowDurationMins: 300, resetsAt: 1783767909 },
    secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1784354709 },
    credits: { hasCredits: false, unlimited: false, balance: "0" },
    individualLimit: null, planType: "pro", rateLimitReachedType: null,
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: "codex", limitName: null,
      primary: { usedPercent: 45, windowDurationMins: 300, resetsAt: 1783767909 },
      secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1784354709 },
      credits: { hasCredits: false, unlimited: false, balance: "0" },
      individualLimit: null, planType: "pro", rateLimitReachedType: null,
    },
    codex_bengalfox: {
      limitId: "codex_bengalfox", limitName: "GPT-5.3-Codex-Spark",
      primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1783776279 },
      secondary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1784363079 },
      credits: null, individualLimit: null, planType: "pro", rateLimitReachedType: null,
    },
  },
};

test("normalizeAppServerRateLimits: byLimitId 전체를 snake_case 스냅샷으로 변환", () => {
  const out = normalizeAppServerRateLimits(FIXTURE, "2026-07-11T09:00:00.000Z");
  const codex = out.find((s) => s.limitId === "codex");
  assert.equal(codex.primary.used_percent, 45);
  assert.equal(codex.primary.window_minutes, 300);
  assert.equal(codex.primary.resets_at, 1783767909);
  assert.equal(codex.secondary.window_minutes, 10080);
  assert.equal(codex.timestamp, "2026-07-11T09:00:00.000Z");
  assert.equal(codex.probe, true);
  assert.equal(codex.tokens, null);
  const spark = out.find((s) => s.limitId === "codex_bengalfox");
  assert.equal(spark.primary.used_percent, 3);
});

test("normalizeAppServerRateLimits: byLimitId 없으면 top-level rateLimits 폴백", () => {
  const out = normalizeAppServerRateLimits({ rateLimits: FIXTURE.rateLimits }, "2026-07-11T09:00:00.000Z");
  assert.equal(out.length, 1);
  assert.equal(out[0].limitId, "codex");
});

test("normalizeAppServerRateLimits: null/빈 응답은 빈 배열", () => {
  assert.deepEqual(normalizeAppServerRateLimits(null, "t"), []);
  assert.deepEqual(normalizeAppServerRateLimits({}, "t"), []);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/unit/hud-codex-probe.test.mjs`
Expected: FAIL — `Cannot find module .../hud/providers/codex-probe.mjs`

- [ ] **Step 3: 최소 구현**

```js
// hud/providers/codex-probe.mjs
// codex app-server account/rateLimits/read 능동 프로브 + 정규화.
// 세션 이벤트(snake_case) 파이프라인에 합류 가능한 스냅샷을 만든다.

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
  if (result.rateLimits?.limitId) return [toSnapshot(result.rateLimits, nowIso)];
  return [];
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --test tests/unit/hud-codex-probe.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 5: 커밋**

```bash
git add hud/providers/codex-probe.mjs tests/unit/hud-codex-probe.test.mjs
git commit -m "feat(hud): app-server rate limits 응답 정규화기 추가"
```

---

### Task 2: stdio JSON-RPC 프로브 클라이언트 `probeRateLimitsViaAppServer`

**Files:**
- Modify: `hud/providers/codex-probe.mjs`
- Test: `tests/unit/hud-codex-probe.test.mjs`

**Interfaces:**
- Consumes: Task 1의 `normalizeAppServerRateLimits`.
- Produces: `async probeRateLimitsViaAppServer({ codexHome, spawnBin = "codex", spawnArgs = ["app-server"], timeoutMs = 10000, now = new Date() })` → `Array<Snapshot>` (성공) / `null` (스폰 실패·타임아웃·에러 응답 — fail-open). `codexHome`이 주어지면 자식 env에 `CODEX_HOME` 주입.

- [ ] **Step 1: 실패하는 테스트 작성** — 가짜 app-server(node 스크립트)로 실서버 없이 검증

```js
// tests/unit/hud-codex-probe.test.mjs 에 추가
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRateLimitsViaAppServer } from "../../hud/providers/codex-probe.mjs";

function writeFakeServer(body) {
  const dir = mkdtempSync(join(tmpdir(), "tfx-probe-test-"));
  const p = join(dir, "fake-app-server.mjs");
  writeFileSync(p, body);
  return p;
}

const FAKE_OK = `
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { codexHome: process.env.CODEX_HOME || "" } }) + "\\n");
    } else if (msg.method === "account/rateLimits/read") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
        rateLimits: { limitId: "codex", limitName: null,
          primary: { usedPercent: 45, windowDurationMins: 300, resetsAt: 1783767909 },
          secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1784354709 },
          credits: null, individualLimit: null, planType: "pro", rateLimitReachedType: null } } }) + "\\n");
    }
  }
});
`;

test("probeRateLimitsViaAppServer: 정상 왕복 → 정규화 스냅샷", async () => {
  const fake = writeFakeServer(FAKE_OK);
  const out = await probeRateLimitsViaAppServer({
    spawnBin: process.execPath, spawnArgs: [fake], timeoutMs: 5000,
    now: new Date("2026-07-11T09:00:00.000Z"),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].primary.used_percent, 45);
  assert.equal(out[0].timestamp, "2026-07-11T09:00:00.000Z");
});

test("probeRateLimitsViaAppServer: 타임아웃이면 null (fail-open)", async () => {
  const fake = writeFakeServer("setInterval(() => {}, 1000);");
  const out = await probeRateLimitsViaAppServer({
    spawnBin: process.execPath, spawnArgs: [fake], timeoutMs: 300,
  });
  assert.equal(out, null);
});

test("probeRateLimitsViaAppServer: 스폰 실패면 null", async () => {
  const out = await probeRateLimitsViaAppServer({
    spawnBin: "/nonexistent/bin/never", timeoutMs: 500,
  });
  assert.equal(out, null);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/unit/hud-codex-probe.test.mjs`
Expected: FAIL — `probeRateLimitsViaAppServer is not a function`

- [ ] **Step 3: 구현**

```js
// hud/providers/codex-probe.mjs 에 추가
import { spawn } from "node:child_process";

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
        env: codexHome ? { ...process.env, CODEX_HOME: codexHome } : process.env,
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
      try { child.kill(); } catch { /* 이미 종료 */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const send = (obj) => {
      try { child.stdin.write(`${JSON.stringify(obj)}\n`); } catch { finish(null); }
    };
    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let idx = buf.indexOf("\n");
      while (idx >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        idx = buf.indexOf("\n");
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && msg.result) {
          send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} });
        } else if (msg.id === 2) {
          if (msg.error) finish(null);
          else finish(normalizeAppServerRateLimits(msg.result, now.toISOString()));
        }
      }
    });
    send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { clientInfo: { name: "triflux-hud-probe", title: "triflux HUD quota probe", version: "1.0.0" } },
    });
  });
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --test tests/unit/hud-codex-probe.test.mjs`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
git add hud/providers/codex-probe.mjs tests/unit/hud-codex-probe.test.mjs
git commit -m "feat(hud): app-server stdio 프로브 클라이언트 추가"
```

---

### Task 3: 계정 열거 + JWT 만료 가드 + TTL 스로틀 `listProbeTargets`

**Files:**
- Modify: `hud/providers/codex-probe.mjs`, `hud/constants.mjs`
- Test: `tests/unit/hud-codex-probe.test.mjs`

**Interfaces:**
- Consumes: 없음(파일시스템만).
- Produces: `listProbeTargets({ codexAuthPath, brokerCacheDir, stateFilePath, ttlMs, nowMs })` → `Array<{ key, codexHome }>`; `recordProbe(stateFilePath, key, nowMs)`. 현재 계정(`~/.codex`) + 브로커 캐시(`codex-auth-*.json` → 임시 CODEX_HOME 디렉토리 자료화). access_token JWT `exp`가 `nowMs/1000 + 600` 미만이면 제외(토큰 refresh 강제 금지 원칙). 상태파일 `{ [key]: lastProbeMs }`로 TTL 미경과 계정 제외.
- 신규 상수(`hud/constants.mjs`): `CODEX_PROBE_STATE_PATH = join(homedir(), ".claude", "cache", "codex-probe-state.json")`, `CODEX_PROBE_TTL_MS = 5 * 60 * 1000`, `CODEX_PROBE_TIMEOUT_MS = 10000`, `CODEX_BROKER_AUTH_CACHE_DIR = join(homedir(), ".claude", "cache", "tfx-hub")`.

- [ ] **Step 1: 실패하는 테스트 작성**

```js
// tests/unit/hud-codex-probe.test.mjs 에 추가
import { mkdirSync, readFileSync } from "node:fs";
import { listProbeTargets, recordProbe } from "../../hud/providers/codex-probe.mjs";

function jwtWithExp(expSec) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: expSec, email: "t@t" })}.x`;
}

function makeAuthDir(root, name, expSec) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: jwtWithExp(expSec), id_token: jwtWithExp(expSec) } }));
  return dir;
}

test("listProbeTargets: 현재 계정 + 브로커 캐시 열거, 만료 임박 제외, TTL 스로틀", () => {
  const root = mkdtempSync(join(tmpdir(), "tfx-probe-targets-"));
  const nowMs = Date.parse("2026-07-11T09:00:00Z");
  const okExp = Math.floor(nowMs / 1000) + 3600;
  const nearExp = Math.floor(nowMs / 1000) + 60; // 10분 미만 → 제외 대상
  const codexDir = makeAuthDir(root, "codex-home", okExp);
  const brokerDir = join(root, "broker");
  mkdirSync(brokerDir, { recursive: true });
  writeFileSync(join(brokerDir, "codex-auth-alpha.json"), JSON.stringify({ tokens: { access_token: jwtWithExp(okExp) } }));
  writeFileSync(join(brokerDir, "codex-auth-beta.json"), JSON.stringify({ tokens: { access_token: jwtWithExp(nearExp) } }));
  const stateFile = join(root, "probe-state.json");

  const targets = listProbeTargets({
    codexAuthPath: join(codexDir, "auth.json"),
    brokerCacheDir: brokerDir,
    stateFilePath: stateFile,
    ttlMs: 300000,
    nowMs,
  });
  const keys = targets.map((t) => t.key).sort();
  assert.deepEqual(keys, ["alpha", "current"]); // beta는 만료 임박으로 제외
  for (const t of targets) {
    assert.ok(t.codexHome, `codexHome 필요: ${t.key}`);
    const auth = JSON.parse(readFileSync(join(t.codexHome, "auth.json"), "utf-8"));
    assert.ok(auth.tokens.access_token);
  }

  recordProbe(stateFile, "alpha", nowMs);
  const second = listProbeTargets({
    codexAuthPath: join(codexDir, "auth.json"),
    brokerCacheDir: brokerDir,
    stateFilePath: stateFile,
    ttlMs: 300000,
    nowMs: nowMs + 1000, // TTL 미경과
  });
  assert.deepEqual(second.map((t) => t.key), ["current"]); // alpha 스로틀됨
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/unit/hud-codex-probe.test.mjs`
Expected: FAIL — `listProbeTargets is not a function`

- [ ] **Step 3: 구현**

```js
// hud/providers/codex-probe.mjs 에 추가
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function readJwtExpSec(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf-8"));
    return Number(payload.exp) || 0;
  } catch {
    return 0;
  }
}

function readJsonFile(path) {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

const EXP_MARGIN_SEC = 600; // 만료 10분 전이면 refresh 강제 위험 — 제외

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
  } catch { /* 상태 기록 실패는 무시 — 다음 사이클에 재시도 */ }
}

export function listProbeTargets({ codexAuthPath, brokerCacheDir, stateFilePath, ttlMs, nowMs }) {
  const state = readJsonFile(stateFilePath) || {};
  const due = (key) => !(Number(state[key]) > 0 && nowMs - Number(state[key]) < ttlMs);
  const targets = [];

  const currentAuth = readJsonFile(codexAuthPath);
  if (currentAuth && accessTokenUsable(currentAuth, nowMs) && due("current")) {
    targets.push({ key: "current", codexHome: dirname(codexAuthPath) });
  }

  if (brokerCacheDir && existsSync(brokerCacheDir)) {
    let files = [];
    try {
      files = readdirSync(brokerCacheDir).filter((f) => /^codex-auth-.+\.json$/.test(f));
    } catch { files = []; }
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
```

- [ ] **Step 4: 통과 확인 + constants 추가**

`hud/constants.mjs`에 추가:

```js
export const CODEX_PROBE_STATE_PATH = join(
  homedir(),
  ".claude",
  "cache",
  "codex-probe-state.json",
);
export const CODEX_BROKER_AUTH_CACHE_DIR = join(
  homedir(),
  ".claude",
  "cache",
  "tfx-hub",
);
export const CODEX_PROBE_TTL_MS = 5 * 60 * 1000; // 계정당 최소 프로브 간격
export const CODEX_PROBE_TIMEOUT_MS = 10_000;
```

Run: `node --test tests/unit/hud-codex-probe.test.mjs`
Expected: PASS (7 tests)

- [ ] **Step 5: 커밋**

```bash
git add hud/providers/codex-probe.mjs hud/constants.mjs tests/unit/hud-codex-probe.test.mjs
git commit -m "feat(hud): probe 대상 계정 열거 + JWT 만료 가드 + TTL 스로틀"
```

---

### Task 4: 파이프라인 합류 — `getCodexRateLimits({extraSnapshots})` + refresh 통합

**Files:**
- Modify: `hud/providers/codex.mjs`
- Test: `tests/unit/hud-codex-bucket.test.mjs`

**Interfaces:**
- Consumes: Task 1~3 전부, 기존 `mergeRateLimitSnapshots`/`selectCodexSnapshot`.
- Produces: `getCodexRateLimits({ sessionsRoot, now, maxLinesPerFile, extraSnapshots = [] })` — extraSnapshots가 오늘+어제 병합 스냅샷 풀(recentSnapshots)에 합류. `refreshCodexRateLimitsCache()`가 `TFX_CODEX_PROBE !== "0"`일 때 `listProbeTargets` → `probeRateLimitsViaAppServer` 병렬 실행(Promise.allSettled) → 결과를 extraSnapshots로 전달.

- [ ] **Step 1: 실패하는 테스트 작성**

```js
// tests/unit/hud-codex-bucket.test.mjs 에 추가 (기존 import/헬퍼 재사용)
test("getCodexRateLimits: probe extraSnapshots가 낡은 세션 데이터를 이긴다", () => {
  // 기존 테스트 헬퍼로 세션 fixture 디렉토리 구성: 오늘 세션에 used 6%(낡음, T-2h) 스냅샷 1건
  // (파일 작성 헬퍼는 이 테스트 파일의 기존 makeSessionFixture 패턴을 그대로 사용)
  const now = new Date("2026-07-11T09:00:00.000Z");
  const probeSnapshot = {
    limitId: "codex", limitName: null,
    primary: { used_percent: 45, window_minutes: 300, resets_at: Math.floor(now.getTime() / 1000) + 3600 },
    secondary: { used_percent: 7, window_minutes: 10080, resets_at: Math.floor(now.getTime() / 1000) + 86400 * 6 },
    credits: null, tokens: null, contextWindow: null,
    timestamp: now.toISOString(), probe: true,
  };
  const buckets = getCodexRateLimits({
    sessionsRoot: fixtureRootWithStaleSixPercent(now), // 기존 헬퍼 패턴으로 구성
    now,
    extraSnapshots: [probeSnapshot],
  });
  assert.equal(buckets.codex.primary.used_percent, 45); // probe(신선·max-used)가 선택됨
});
```

(fixture 헬퍼가 없으면 이 테스트 파일의 기존 세션-디렉토리 구성 패턴을 함수로 추출해 재사용 — 새 패턴 발명 금지.)

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/unit/hud-codex-bucket.test.mjs`
Expected: FAIL — extraSnapshots 미지원으로 6%가 선택됨

- [ ] **Step 3: 구현**

`hud/providers/codex.mjs` 변경 2곳:

```js
// (1) 시그니처 + 합류
export function getCodexRateLimits({
  sessionsRoot = join(homedir(), ".codex", "sessions"),
  now = new Date(),
  maxLinesPerFile = 800,
  extraSnapshots = [],
} = {}) {
  let syntheticBucket = null;
  const recentSnapshots = [...extraSnapshots]; // probe 스냅샷은 항상 병합 풀에 선참
  const nowSec = Math.floor(now.getTime() / 1000);
  // ... 이하 기존 루프 그대로 (dayOffset<=1에서 recentSnapshots에 push하는 구조 불변)
```

단, extraSnapshots만 있고 세션 스냅샷이 0건인 경우에도 병합이 실행되도록, dayOffset=1 평가 시 `recentSnapshots.length > 0`이면 병합·반환하는 기존 흐름이 그대로 동작함을 확인한다(오늘·어제 디렉토리가 아예 없어도 `files = []`로 진행하는 구조라 추가 분기 불필요 — 확인 후 필요 시에만 최소 수정).

```js
// (2) refresh 통합
import {
  CODEX_AUTH_PATH,
  CODEX_BROKER_AUTH_CACHE_DIR,
  CODEX_PROBE_STATE_PATH,
  CODEX_PROBE_TIMEOUT_MS,
  CODEX_PROBE_TTL_MS,
  // ...기존 import 유지
} from "../constants.mjs";
import {
  listProbeTargets,
  probeRateLimitsViaAppServer,
  recordProbe,
} from "./codex-probe.mjs";

export async function collectProbeSnapshots(now = new Date()) {
  if (process.env.TFX_CODEX_PROBE === "0") return [];
  let targets = [];
  try {
    targets = listProbeTargets({
      codexAuthPath: CODEX_AUTH_PATH,
      brokerCacheDir: CODEX_BROKER_AUTH_CACHE_DIR,
      stateFilePath: CODEX_PROBE_STATE_PATH,
      ttlMs: Number(process.env.TFX_CODEX_PROBE_TTL_MS) || CODEX_PROBE_TTL_MS,
      nowMs: now.getTime(),
    });
  } catch {
    return [];
  }
  const settled = await Promise.allSettled(
    targets.map(async (t) => {
      const snapshots = await probeRateLimitsViaAppServer({
        codexHome: t.codexHome,
        timeoutMs: CODEX_PROBE_TIMEOUT_MS,
        now,
      });
      recordProbe(CODEX_PROBE_STATE_PATH, t.key, now.getTime());
      return snapshots || [];
    }),
  );
  return settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

export async function refreshCodexRateLimitsCache() {
  const now = new Date();
  const extraSnapshots = await collectProbeSnapshots(now);
  const buckets = getCodexRateLimits({ now, extraSnapshots });
  writeJsonSafe(CODEX_QUOTA_CACHE_PATH, { timestamp: Date.now(), buckets });
  return buckets;
}
```

`refreshCodexRateLimitsCache`가 async로 바뀌므로 호출부 확인 필수: `hud/hud-qos-status.mjs`의 `--refresh-codex-rate-limits` 처리 경로에서 `await` 하도록 수정(해당 경로는 detached 자식 프로세스라 블로킹 무해). 그 외 동기 호출부가 있으면 전수 조사 후 await 정합화(`rg -n "refreshCodexRateLimitsCache" hud/ tests/`).

- [ ] **Step 4: 통과 확인 + 전체 스위트**

Run: `node --test tests/unit/hud-codex-bucket.test.mjs && npm test`
Expected: 신규 테스트 PASS, 전체 green (0 fail)

- [ ] **Step 5: 커밋**

```bash
git add hud/providers/codex.mjs hud/hud-qos-status.mjs tests/unit/hud-codex-bucket.test.mjs
git commit -m "feat(hud): codex quota 능동 프로브를 refresh 파이프라인에 통합"
```

---

### Task 5: 미러/트윈 동기 + 라이브 검증

**Files:**
- Mirror: `packages/core/hud/**`, `packages/triflux/hud/**` (변경된 hud 파일 전부)
- Twin: `~/.claude/hud/**`

**Interfaces:**
- Consumes: Task 1~4의 최종 hud 파일들.
- Produces: 배포 표면 3곳 byte-identical + 라이브 검증 증거.

- [ ] **Step 1: 미러 cp + 검증**

```bash
for f in providers/codex.mjs providers/codex-probe.mjs constants.mjs; do
  cp "hud/$f" "packages/core/hud/$f"
  cp "hud/$f" "packages/triflux/hud/$f"
  diff -q "hud/$f" "packages/core/hud/$f" && diff -q "hud/$f" "packages/triflux/hud/$f"
done
```

Expected: diff 출력 없음 (exit 0)

- [ ] **Step 2: 트윈 cp + 검증**

```bash
for f in providers/codex.mjs providers/codex-probe.mjs constants.mjs; do
  cp "hud/$f" "$HOME/.claude/hud/$f"
  diff -q "hud/$f" "$HOME/.claude/hud/$f"
done
```

Expected: diff 출력 없음

- [ ] **Step 3: 라이브 검증 (실계정, 현재 계정 1개만 — 브로커 캐시 프로브는 TTL 상태 확인까지)**

```bash
rm -f ~/.claude/cache/codex-probe-state.json
node ~/.claude/hud/hud-qos-status.mjs --refresh-codex-rate-limits
python3 -c "
import json,time
d=json.load(open('$HOME/.claude/cache/codex-rate-limits-cache.json'))
print('age_s:', round(time.time()-d['timestamp']/1000))
print('codex primary used:', d['buckets']['codex']['primary']['used_percent'])
print('probe state:', json.load(open('$HOME/.claude/cache/codex-probe-state.json')))
"
```

Expected: age_s < 30, used가 app-server 실값과 일치(세션 이벤트가 낡아도 신선), probe state에 `current` 키 기록됨.

- [ ] **Step 4: 전체 게이트**

```bash
npm test
npx biome check hud/providers/codex-probe.mjs hud/providers/codex.mjs hud/constants.mjs
```

Expected: 전체 green, 변경 파일 lint clean

- [ ] **Step 5: 커밋**

```bash
git add packages/core/hud packages/triflux/hud
git commit -m "chore(hud): codex probe 미러 동기 (core/triflux)"
```

---

## 리스크 및 완화

| 리스크 | 완화 |
|--------|------|
| app-server가 managed-auth 모드에서 자체 토큰 refresh → 브로커 캐시 사본과 refresh_token 분기(#78 재발) | 만료 10분 이내 계정 skip(Task 3), 임시 CODEX_HOME 사본에만 접근, 원본 auth 파일 무변경. 잔여 위험: 유효 토큰이라도 서버가 자발적 refresh할 가능성 — 라이브 검증에서 브로커 원본 mtime 불변 확인, 변하면 브로커 캐시 프로브를 default-off(TFX_CODEX_PROBE_BROKER=1 opt-in)로 강등 |
| codex 버전별 app-server 프로토콜 드리프트 | 실패 시 null fail-open → passive 세션 스캔만으로 동작(현행과 동일). 스파이크는 0.144.1 실측 |
| statusline refresh마다 스폰 비용 | 계정당 TTL 5분 + 기존 30s 스폰락 이중 게이트. 프로브는 detached refresh 자식에서만 실행 — HUD 렌더 비블로킹 |
| probe 스냅샷의 limit_id가 codex 외 다수(`codex_bengalfox` 등) | 기존 병합이 limit_id별로 처리하므로 자연 수용. HUD는 codex 키만 렌더 — 변화 없음 |

## Self-Review 체크

- 스펙 커버리지: 능동 갱신(①app-server 채택/②HTTP는 기각-불요/③프로브 불요), 주기·트리거(④statusline 경로+TTL), auth 안전(⑤만료 가드+사본) — 전 항목 태스크 매핑 확인.
- 타입 일관성: Snapshot shape(snake_case 버킷)가 Task 1 정의 → Task 4 소비까지 동일. `probe: true` 필드는 부가 메타(소비자 없음, 향후 표시용).
- 플레이스홀더: 없음 — 모든 코드/커맨드 실물. Task 4 Step 1의 fixture 헬퍼만 기존 테스트 패턴 재사용 지시(신규 발명 금지 명시).
