// hub/team/health-probe.mjs — 4단계 health model + INPUT_WAIT 감지
// 기존 cli-adapter-base.mjs:stallThresholdMs(30s)와 headless.mjs:STALL_DEFAULTS(120s)를
// 4단계 probe 모델로 교체. stdout+stderr 통합 스트림으로 평가 (F3 해결).

import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Health probe level 정의.
 * L0: Process alive (PID 존재 + exit code 없음)
 * L1: Output advancing (stdout+stderr 통합, 30s)
 * L1.5: INPUT_WAIT 감지 (질문 패턴이면 stall이 아니라 input-wait)
 * L2: MCP connected (opt-in, heartbeat, 30s)
 * L3: Prompt acknowledged (첫 tool call/텍스트, 120s)
 */
export const PROBE_LEVELS = Object.freeze({
  L0: "alive",
  L1: "advancing",
  L2: "mcp_connected",
  L3: "prompt_ack",
});

/** 기본 설정 (기존 stallThresholdMs/stallTimeout 값 계승) */
export const PROBE_DEFAULTS = Object.freeze({
  intervalMs: 5_000,
  probeTimeoutMs: 5_000,
  l1ThresholdMs: 30_000,
  l2ThresholdMs: 30_000,
  l3ThresholdMs: 120_000,
  enableL2: false,
  writeStateFile: false,
  stateDir: join(tmpdir(), "tfx-probe"),
});

/**
 * stdin 입력 대기 패턴 (Codex 질문 블로킹 감지)
 * Codex가 질문하며 stdin을 기다리는 경우 stall이 아니라 INPUT_WAIT로 분류.
 */
const INPUT_WAIT_PATTERNS = [
  /\?\s*$/m, // 물음표로 끝나는 줄
  /\b(y\/n|yes\/no)\b/i, // y/n 프롬프트
  /\b(choose|select|pick)\b.*:/i, // choose/select 프롬프트
  /\b(confirm|approve|proceed)\b/i, // confirm 프롬프트
  /\b(enter|input|type)\b.*:/i, // 입력 요청
  /\[.*\]:\s*$/m, // [default]: 형태
  />\s*$/m, // > 프롬프트
];

/**
 * 최근 output에서 INPUT_WAIT 패턴 감지.
 * @param {string} recentOutput — 최근 stdout+stderr 통합 텍스트
 * @returns {{ detected: boolean, pattern: string|null }}
 */
export function detectInputWait(recentOutput) {
  if (!recentOutput) return { detected: false, pattern: null };
  // 마지막 5줄만 검사 (전체 output이 아닌 최근 출력)
  const lines = recentOutput
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-5)
    .join("\n");
  for (const re of INPUT_WAIT_PATTERNS) {
    if (re.test(lines)) {
      return { detected: true, pattern: re.source };
    }
  }
  return { detected: false, pattern: null };
}

/**
 * Health probe 팩토리.
 * @param {object} session — probe 대상 세션 상태 객체
 * @param {number|null} session.pid — 프로세스 PID
 * @param {function} session.getRecentOutput — () => string (최근 stdout+stderr)
 * @param {function} session.getOutputBytes — () => number (총 output 바이트)
 * @param {boolean} [session.alive] — 프로세스 alive 여부 (외부 업데이트)
 * @param {object} [opts] — PROBE_DEFAULTS 오버라이드
 * @param {function} [opts.onProbe] — (level, result) => void 콜백
 * @param {function} [opts.checkMcp] — () => Promise<boolean> MCP heartbeat 체커 (L2용)
 * @returns {{ start, stop, probe, getStatus }}
 */
export function createHealthProbe(session, opts = {}) {
  const config = { ...PROBE_DEFAULTS, ...opts };
  let timer = null;
  let started = false;

  // L1 tracking
  let lastOutputBytes = 0;
  let lastOutputChangeAt = Date.now();

  // L3 tracking
  let promptAcked = false;
  let spawnedAt = Date.now();

  const status = {
    l0: null, // 'ok' | 'fail'
    l1: null, // 'ok' | 'stall' | 'input_wait'
    l2: null, // 'ok' | 'fail' | 'skip'
    l3: null, // 'ok' | 'timeout'
    lastProbeAt: null,
    inputWaitPattern: null,
  };

  function getStateFilePath() {
    if (typeof config.stateFile === "string" && config.stateFile.length > 0) {
      return config.stateFile;
    }
    const pid = session.pid;
    if (pid == null || pid <= 0) return null;
    return join(config.stateDir, `${pid}.json`);
  }

  function deriveState(result) {
    if (result.l0 === "fail") return "exited";
    if (result.l1 === "input_wait") return "input_wait";
    if (result.l2 === "fail") return "mcp_initializing";
    if (result.l1 === "stall") return "stalled";
    if (result.l3 === "timeout") return "reasoning";
    return "active";
  }

  function writeState(result) {
    if (!config.writeStateFile && !config.stateFile) return;
    const stateFile = getStateFilePath();
    if (!stateFile) return;
    try {
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(
        stateFile,
        JSON.stringify(
          {
            pid: session.pid ?? null,
            state: deriveState(result),
            result,
            updatedAt: new Date(result.ts).toISOString(),
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );
    } catch {
      // probe state is advisory only.
    }
  }

  /**
   * L0: Process alive check.
   */
  function probeL0() {
    const alive =
      session.alive !== undefined
        ? session.alive
        : session.pid != null && session.pid > 0;
    status.l0 = alive ? "ok" : "fail";
    return status.l0;
  }

  /**
   * L1 + L1.5: Output advancing + INPUT_WAIT 감지.
   */
  function probeL1() {
    const currentBytes =
      typeof session.getOutputBytes === "function"
        ? session.getOutputBytes()
        : 0;

    const now = Date.now();

    if (currentBytes !== lastOutputBytes) {
      lastOutputBytes = currentBytes;
      lastOutputChangeAt = now;
      status.l1 = "ok";
      status.inputWaitPattern = null;
      return "ok";
    }

    const silenceMs = now - lastOutputChangeAt;

    if (silenceMs >= config.l1ThresholdMs) {
      // L1.5: INPUT_WAIT 감지 — stall 전에 질문 패턴 체크
      const recentOutput =
        typeof session.getRecentOutput === "function"
          ? session.getRecentOutput()
          : "";
      const inputWait = detectInputWait(recentOutput);

      if (inputWait.detected) {
        status.l1 = "input_wait";
        status.inputWaitPattern = inputWait.pattern;
        return "input_wait";
      }

      status.l1 = "stall";
      status.inputWaitPattern = null;
      return "stall";
    }

    // 아직 threshold 미달
    status.l1 = "ok";
    return "ok";
  }

  /**
   * L2: MCP connected (opt-in).
   */
  async function probeL2() {
    if (!config.enableL2) {
      status.l2 = "skip";
      return "skip";
    }
    if (typeof config.checkMcp !== "function") {
      status.l2 = "skip";
      return "skip";
    }
    try {
      const connected = await Promise.race([
        config.checkMcp(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("probe_timeout")),
            config.probeTimeoutMs,
          ),
        ),
      ]);
      status.l2 = connected ? "ok" : "fail";
    } catch {
      status.l2 = "fail";
    }
    return status.l2;
  }

  /**
   * L3: Prompt acknowledged.
   * 첫 번째 meaningful output이 나오면 ack.
   */
  function probeL3() {
    if (promptAcked) {
      status.l3 = "ok";
      return "ok";
    }

    const currentBytes =
      typeof session.getOutputBytes === "function"
        ? session.getOutputBytes()
        : 0;

    if (currentBytes > 0) {
      promptAcked = true;
      status.l3 = "ok";
      return "ok";
    }

    const elapsed = Date.now() - spawnedAt;
    if (elapsed >= config.l3ThresholdMs) {
      status.l3 = "timeout";
      return "timeout";
    }

    status.l3 = null; // 아직 판정 전
    return null;
  }

  /**
   * 전체 probe 실행 (L0→L1→L2→L3).
   * @returns {Promise<object>} probe 결과
   */
  async function probe() {
    const result = {
      l0: probeL0(),
      l1: probeL1(),
      l2: await probeL2(),
      l3: probeL3(),
      inputWaitPattern: status.inputWaitPattern,
      ts: Date.now(),
    };
    status.lastProbeAt = result.ts;
    writeState(result);

    if (typeof config.onProbe === "function") {
      config.onProbe(result);
    }

    return result;
  }

  function start() {
    if (started) return;
    started = true;
    spawnedAt = Date.now();
    lastOutputChangeAt = Date.now();
    lastOutputBytes = 0;
    promptAcked = false;

    timer = setInterval(() => {
      void probe();
    }, config.intervalMs);
    timer.unref?.();

    // 즉시 첫 probe 실행
    void probe();
  }

  function stop() {
    if (!started) return;
    started = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (config.writeStateFile || config.stateFile) {
      try {
        const stateFile = getStateFilePath();
        if (stateFile) unlinkSync(stateFile);
      } catch {}
    }
  }

  /** L1 tracking 리셋 (restart 후 호출) */
  function resetTracking() {
    lastOutputBytes = 0;
    lastOutputChangeAt = Date.now();
    promptAcked = false;
    spawnedAt = Date.now();
    status.l0 = null;
    status.l1 = null;
    status.l2 = null;
    status.l3 = null;
    status.inputWaitPattern = null;
  }

  return Object.freeze({
    start,
    stop,
    probe,
    resetTracking,
    getStatus: () => ({ ...status }),
    get started() {
      return started;
    },
  });
}
