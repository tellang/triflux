// hub/team/remote-probe.mjs — SSH 경유 원격 세션 health probe
// health-probe.mjs와 동일 인터페이스: { start, stop, probe, getStatus }
// child process PID 대신 SSH capture-pane 폴링으로 상태 추적.
//
// L0: SSH 연결 + psmux 세션 존재 확인
// L1: capture-pane 출력 변화 감지 (advancing)
// L1.5: INPUT_WAIT 패턴 감지 (detectInputWait 재사용)
// L3: 완료 토큰 감지 (__TRIFLUX_DONE__ 또는 프롬프트 idle)

import { execFileSync } from "node:child_process";
import { detectInputWait, PROBE_DEFAULTS } from "./health-probe.mjs";

/** 완료 토큰 패턴 */
const COMPLETION_TOKEN_RE = /__TRIFLUX_DONE__/;

/** 프롬프트 idle 패턴 (Claude Code 프롬프트 복귀) */
const _PROMPT_IDLE_RE = /(\u276f|\u2795|>\s*$)/;

/**
 * SSH 경유로 원격 psmux capture-pane 실행.
 * @param {string} host — SSH 호스트
 * @param {string} paneTarget — psmux pane target (e.g. "session:0.0")
 * @param {number} lines — 캡처할 줄 수
 * @param {object} [deps] — 테스트용 의존성 주입
 * @returns {string|null} 캡처 텍스트 또는 null (실패)
 */
export function sshCapturePane(host, paneTarget, lines = 20, deps = {}) {
  const execFn = deps.execFileSync || execFileSync;
  try {
    const output = execFn(
      "ssh",
      [
        "-o",
        "ConnectTimeout=5",
        "-o",
        "BatchMode=yes",
        host,
        `psmux capture-pane -t ${paneTarget} -p -S -`,
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const nonEmpty = output.split("\n").filter((line) => line.trim() !== "");
    return nonEmpty.slice(-lines).join("\n");
  } catch {
    return null;
  }
}

/**
 * SSH 경유로 원격 psmux 세션 존재 여부 확인.
 * @param {string} host
 * @param {string} sessionName
 * @param {object} [deps]
 * @returns {boolean}
 */
export function sshSessionExists(host, sessionName, deps = {}) {
  const execFn = deps.execFileSync || execFileSync;
  try {
    execFn(
      "ssh",
      [
        "-o",
        "ConnectTimeout=5",
        "-o",
        "BatchMode=yes",
        host,
        `psmux has-session -t ${sessionName}`,
      ],
      {
        timeout: 10_000,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Remote health probe 팩토리.
 * health-probe.mjs의 createHealthProbe와 동일 인터페이스를 제공하되,
 * SSH capture-pane 폴링 기반으로 동작한다.
 *
 * @param {object} session — probe 대상 세션 정보
 * @param {string} session.host — SSH 호스트
 * @param {string} session.paneTarget — psmux pane target
 * @param {string} session.sessionName — psmux 세션 이름
 * @param {object} [opts] — PROBE_DEFAULTS 오버라이드
 * @param {function} [opts.onProbe] — (result) => void 콜백
 * @param {object} [opts.deps] — 테스트용 의존성 주입
 * @returns {{ start, stop, probe, getStatus, started }}
 */
export function createRemoteProbe(session, opts = {}) {
  const config = { ...PROBE_DEFAULTS, ...opts };
  const deps = opts.deps || {};
  let timer = null;
  let started = false;

  // L1 tracking — 출력 변화 감지
  let lastCaptureHash = "";
  let lastOutputChangeAt = Date.now();

  // L3 tracking — 완료 토큰 / prompt idle
  let promptAcked = false;
  let spawnedAt = Date.now();

  const status = {
    l0: null,
    l1: null,
    l2: "skip", // 원격은 MCP L2 미지원
    l3: null,
    lastProbeAt: null,
    inputWaitPattern: null,
  };

  /**
   * L0: SSH 연결 + psmux 세션 존재 확인.
   */
  function probeL0() {
    const exists = sshSessionExists(session.host, session.sessionName, deps);
    status.l0 = exists ? "ok" : "fail";
    return status.l0;
  }

  /**
   * L1 + L1.5: capture-pane 출력 변화 + INPUT_WAIT 감지.
   * @param {string|null} captured — 이미 캡처된 텍스트 (L0에서 재사용)
   */
  function probeL1(captured) {
    const now = Date.now();

    if (captured == null) {
      // 캡처 실패 — 이전 상태 유지
      return status.l1 || null;
    }

    // 단순 해시: 길이 + 처음/끝 문자 조합 (crypto 불필요)
    const hash = `${captured.length}:${captured.slice(0, 32)}:${captured.slice(-32)}`;

    if (hash !== lastCaptureHash) {
      lastCaptureHash = hash;
      lastOutputChangeAt = now;
      status.l1 = "ok";
      status.inputWaitPattern = null;
      return "ok";
    }

    const silenceMs = now - lastOutputChangeAt;

    if (silenceMs >= config.l1ThresholdMs) {
      // L1.5: INPUT_WAIT 패턴 감지
      const inputWait = detectInputWait(captured);

      if (inputWait.detected) {
        status.l1 = "input_wait";
        status.inputWaitPattern = inputWait.pattern;
        return "input_wait";
      }

      status.l1 = "stall";
      status.inputWaitPattern = null;
      return "stall";
    }

    status.l1 = "ok";
    return "ok";
  }

  /**
   * L3: 완료 토큰 또는 프롬프트 idle 감지.
   * @param {string|null} captured
   */
  function probeL3(captured) {
    if (promptAcked) {
      status.l3 = "ok";
      return "ok";
    }

    if (captured != null && captured.length > 0) {
      // 완료 토큰 감지 → 즉시 ok
      if (COMPLETION_TOKEN_RE.test(captured)) {
        promptAcked = true;
        status.l3 = "completed";
        return "completed";
      }

      // 출력이 있으면 prompt acknowledged
      promptAcked = true;
      status.l3 = "ok";
      return "ok";
    }

    const elapsed = Date.now() - spawnedAt;
    if (elapsed >= config.l3ThresholdMs) {
      status.l3 = "timeout";
      return "timeout";
    }

    status.l3 = null;
    return null;
  }

  /**
   * 전체 probe 실행 (L0 → capture → L1 → L3).
   * @returns {Promise<object>} probe 결과
   */
  async function probe() {
    const l0 = probeL0();

    // L0 실패 시 나머지 probe 스킵
    let captured = null;
    if (l0 === "ok") {
      captured = sshCapturePane(session.host, session.paneTarget, 20, deps);
    }

    const l1 = probeL1(captured);
    const l3 = probeL3(captured);

    const result = {
      l0,
      l1,
      l2: "skip",
      l3,
      inputWaitPattern: status.inputWaitPattern,
      ts: Date.now(),
    };
    status.lastProbeAt = result.ts;

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
    lastCaptureHash = "";
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
  }

  /** tracking 리셋 (restart 후 호출) */
  function resetTracking() {
    lastCaptureHash = "";
    lastOutputChangeAt = Date.now();
    promptAcked = false;
    spawnedAt = Date.now();
    status.l0 = null;
    status.l1 = null;
    status.l2 = "skip";
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
