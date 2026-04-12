// hub/team/tui-widgets.mjs — UX 리뉴얼 위젯 (ISSUE-14)
// k9s/lazygit/btop 스타일 위젯: 스파크라인, 검색, 패널 리사이즈

import { color, dim, FG, MOCHA, stripAnsi, wcswidth } from "./ansi.mjs";

// ── 스파크라인 ────────────────────────────────────────────────────────────
// Unicode block elements for sparkline rendering
const SPARK_CHARS = "▁▂▃▄▅▆▇█";

/**
 * 토큰 소비 추이를 미니 스파크라인으로 렌더링
 * @param {number[]} values - 시계열 값 배열
 * @param {number} [width=8] - 표시 폭 (문자 수)
 * @param {string} [fg] - ANSI 색상 시퀀스
 * @returns {string} 스파크라인 문자열
 */
export function sparkline(values, width = 8, fg = MOCHA.executing) {
  if (!values || values.length === 0) return dim("─".repeat(width));

  // 최근 width개만 사용
  const data = values.slice(-width);
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const chars = data.map((v) => {
    const idx = Math.round(((v - min) / range) * (SPARK_CHARS.length - 1));
    return SPARK_CHARS[idx];
  });

  // width보다 짧으면 왼쪽 패딩
  const pad = width - chars.length;
  const padStr = pad > 0 ? dim("─".repeat(pad)) : "";
  return padStr + color(chars.join(""), fg);
}

/**
 * 워커별 토큰 히스토리 추적기
 * @param {number} [maxSamples=16] - 최대 샘플 수
 */
export function createTokenTracker(maxSamples = 16) {
  const histories = new Map();

  return {
    /** 워커의 토큰 값을 기록 */
    record(workerName, tokens) {
      if (tokens === null || tokens === undefined || tokens === "") return;
      const numValue =
        typeof tokens === "number" ? tokens : parseFloat(String(tokens));
      if (!Number.isFinite(numValue)) return;

      let history = histories.get(workerName);
      if (!history) {
        history = [];
        histories.set(workerName, history);
      }
      history.push(numValue);
      if (history.length > maxSamples) history.shift();
    },

    /** 워커의 스파크라인 반환 */
    sparkline(workerName, width = 8) {
      const history = histories.get(workerName);
      return sparkline(history, width);
    },

    /** 워커의 히스토리 반환 */
    getHistory(workerName) {
      return histories.get(workerName) || [];
    },

    clear() {
      histories.clear();
    },
  };
}

// ── 검색 (/ + n/N) ───────────────────────────────────────────────────────
/**
 * 인라인 검색 상태 관리자
 * vim 스타일 / 검색 + n(다음)/N(이전) 탐색
 */
export function createSearchState() {
  let query = "";
  let isActive = false;
  let inputBuffer = "";

  return {
    /** 검색 모드 활성화 */
    activate() {
      isActive = true;
      inputBuffer = "";
      query = "";
    },

    /** 검색 모드 비활성화 */
    deactivate() {
      isActive = false;
      inputBuffer = "";
    },

    /** 현재 검색 활성 여부 */
    get active() {
      return isActive;
    },

    /** 현재 쿼리 */
    get query() {
      return query;
    },

    /** 입력 버퍼 (검색 모드 중 타이핑) */
    get buffer() {
      return inputBuffer;
    },

    /** 키 입력 처리. true 반환 시 해당 키를 소비함 */
    handleKey(key) {
      if (!isActive) return false;

      // Enter: 검색 확정
      if (key === "\r" || key === "\n") {
        query = inputBuffer;
        isActive = false;
        return true;
      }

      // Escape: 검색 취소
      if (key === "\x1b") {
        this.deactivate();
        return true;
      }

      // Backspace
      if (key === "\x7f" || key === "\b") {
        inputBuffer = inputBuffer.slice(0, -1);
        return true;
      }

      // Ctrl+C: 취소
      if (key === "\u0003") {
        this.deactivate();
        return true;
      }

      // 일반 문자
      if (key.length === 1 && key >= " ") {
        inputBuffer += key;
        return true;
      }

      return true; // 검색 모드 중 다른 키는 무시
    },

    /**
     * 이름 목록에서 쿼리와 매칭되는 인덱스 찾기
     * @param {string[]} names - 워커 이름 배열
     * @param {number} currentIdx - 현재 선택 인덱스
     * @param {number} direction - 1(다음) 또는 -1(이전)
     * @returns {number} 매칭 인덱스 또는 -1
     */
    findMatch(names, currentIdx, direction = 1) {
      if (!query || names.length === 0) return -1;
      const q = query.toLowerCase();
      const len = names.length;
      for (let i = 1; i <= len; i++) {
        const idx = (currentIdx + i * direction + len) % len;
        if (names[idx].toLowerCase().includes(q)) return idx;
      }
      return -1;
    },

    /** 검색 프롬프트 렌더링 */
    renderPrompt(width) {
      if (!isActive) {
        if (query) return dim(` /${query}`);
        return "";
      }
      const prompt = `/${inputBuffer}`;
      const cursor = "█";
      return color(prompt + cursor, MOCHA.blue);
    },
  };
}

// ── 패널 리사이즈 (H/L) ──────────────────────────────────────────────────
/**
 * 패널 비율 관리자
 * H: rail 축소, L: rail 확대 (k9s 스타일)
 */
export function createPanelResizer(opts = {}) {
  const { minRatio = 0.15, maxRatio = 0.5, step = 0.05 } = opts;
  let railRatio = opts.initialRatio || 0.3;

  return {
    get ratio() {
      return railRatio;
    },

    /** rail 비율 축소 (H) — detail 패널 확대 */
    shrinkRail() {
      railRatio = Math.max(minRatio, railRatio - step);
      return railRatio;
    },

    /** rail 비율 확대 (L) — detail 패널 축소 */
    expandRail() {
      railRatio = Math.min(maxRatio, railRatio + step);
      return railRatio;
    },

    /** 비율 리셋 */
    reset() {
      railRatio = opts.initialRatio || 0.3;
      return railRatio;
    },
  };
}

// ── vim 모션 헬퍼 ─────────────────────────────────────────────────────────
/**
 * gg/G 모션을 위한 키 시퀀스 감지
 * 두 번 연속 'g'를 누르면 gg (첫 번째 항목으로 이동)
 */
export function createVimMotion() {
  let lastKey = "";
  let lastKeyTime = 0;
  const DOUBLE_TAP_MS = 500;

  return {
    /**
     * 키 입력 처리
     * @returns {"gg"|"G"|null} 감지된 모션 또는 null
     */
    handleKey(key) {
      const now = Date.now();

      if (key === "g") {
        if (lastKey === "g" && now - lastKeyTime < DOUBLE_TAP_MS) {
          lastKey = "";
          return "gg"; // 첫 번째 항목으로
        }
        lastKey = "g";
        lastKeyTime = now;
        return null;
      }

      if (key === "G") {
        lastKey = "";
        return "G"; // 마지막 항목으로
      }

      lastKey = "";
      return null;
    },

    reset() {
      lastKey = "";
      lastKeyTime = 0;
    },
  };
}
