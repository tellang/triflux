// headless 세션 결과 색인. 화면의 HEADLESS_COMPLETE 문자열 대신 읽도록 세션당 JSON 하나를 둔다 (ADR-0034).
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { judgeInstructionAck } from "../lib/jev-addon.mjs";

export const RESULTS_INDEX_VERSION = 1;
const MAX_HEADING_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_HEADINGS_PER_WORKER = 200;

/**
 * 마크다운 본문에서 펜스 코드블록 바깥의 H1~H3 헤딩과 1-기반 줄 번호를 추출한다.
 *
 * @param {string} content
 * @returns {Array<{ level: number, line: number, text: string }>}
 */
export function extractMarkdownHeadings(content) {
  if (typeof content !== "string" || content.length === 0) return [];
  const lines = content.split(/\r?\n/u);
  const headings = [];
  let activeFence = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/u);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      const ch = marker[0];
      const len = marker.length;
      if (!activeFence) {
        activeFence = { ch, len };
        continue;
      }
      if (
        activeFence.ch === ch &&
        len >= activeFence.len &&
        fenceMatch[2].trim() === ""
      ) {
        activeFence = null;
        continue;
      }
    }
    if (activeFence) continue;

    const headingMatch = line.match(
      /^\s{0,3}(#{1,3})[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/u,
    );
    if (!headingMatch) continue;
    const text = headingMatch[2].trim();
    if (!text) continue;
    headings.push({
      level: headingMatch[1].length,
      line: i + 1,
      text,
    });
    if (headings.length >= MAX_HEADINGS_PER_WORKER) break;
  }

  return headings;
}

function readResultFileHeadings(filePath) {
  if (typeof filePath !== "string" || !filePath) return [];
  try {
    if (!existsSync(filePath)) return [];
    const st = statSync(filePath);
    if (!st.isFile() || st.size === 0 || st.size > MAX_HEADING_SCAN_BYTES) {
      return [];
    }
    return extractMarkdownHeadings(readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
}

export function resultsIndexPath(dir, sessionName) {
  return join(dir, `${sessionName}.results.json`);
}

/**
 * @param {string} path
 * @param {string} sessionName
 * @param {Array<{paneName: string, displayName?: string, cli: string, role?: string, resultFile: string}>} workers
 * @param {() => boolean} canWrite
 */
export function createResultsIndex(path, sessionName, workers, canWrite) {
  const now = () => new Date().toISOString();
  const index = {
    version: RESULTS_INDEX_VERSION,
    sessionName,
    startedAt: now(),
    finishedAt: null,
    completed: false,
    workers: workers.map((w) => ({
      paneName: w.paneName,
      displayName: w.displayName || w.paneName,
      cli: w.cli,
      role: w.role || "",
      status: "pending",
      matched: null,
      exitCode: null,
      sessionDead: false,
      startedAt: null,
      finishedAt: null,
      resultFile: w.resultFile,
      headings: [],
      workerModelFile: null,
      workerMcpFile: null,
      ackStatus: null,
      semanticState: null,
      ackConfidence: null,
    })),
  };
  const byPane = new Map(index.workers.map((w) => [w.paneName, w]));

  // 임시 파일에 쓰고 rename 해 읽는 쪽이 반쯤 쓴 JSON 을 보지 않게 한다.
  // 색인은 보조 산출물이라 쓰기 실패가 실행을 멈추면 안 된다.
  const flush = () => {
    if (!canWrite()) return;
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`, "utf8");
      renameSync(tmp, path);
    } catch {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* best-effort */
      }
    }
  };

  return {
    path,
    // 같은 이름의 이전 실행 색인이 남아 있으면 세션을 잡자마자 덮어 오판을 막는다.
    begin: flush,
    workerStarted(paneName) {
      const w = byPane.get(paneName);
      if (!w || w.status !== "pending") return;
      w.status = "running";
      w.startedAt = now();
      flush();
    },
    workerFinished(paneName, { matched, exitCode, sessionDead } = {}) {
      const w = byPane.get(paneName);
      if (!w) return;
      w.status = matched && exitCode === 0 ? "completed" : "failed";
      w.matched = Boolean(matched);
      w.exitCode = exitCode ?? null;
      w.sessionDead = Boolean(sessionDead);
      w.finishedAt = now();
      w.headings = readResultFileHeadings(w.resultFile);
      flush();
    },
    finish(completed, results = []) {
      for (const result of results) {
        const w = byPane.get(result.paneName);
        if (!w) continue;
        if (result.resultFile) {
          w.resultFile = result.resultFile;
        }
        w.workerModelFile = result.workerModelFile ?? null;
        w.workerMcpFile = result.workerMcpFile ?? null;
        w.headings = readResultFileHeadings(w.resultFile);
      }
      // 예외로 끝나면 끝나지 못한 워커를 failed 로 확정해 "아직 도는 중"과 구분한다.
      for (const w of index.workers) {
        if (w.status === "pending" || w.status === "running") {
          w.status = "failed";
          w.finishedAt = now();
        }
        if (!Array.isArray(w.headings) || w.headings.length === 0) {
          w.headings = readResultFileHeadings(w.resultFile);
        }
      }
      index.finishedAt = now();
      index.completed = Boolean(completed);
      flush();
    },
    recordInstructionAck(
      paneName,
      { ackStatus = null, semanticState = null, confidence = null } = {},
    ) {
      const w = byPane.get(paneName);
      if (!w) return null;
      w.ackStatus = ackStatus;
      w.semanticState = semanticState;
      w.ackConfidence = confidence;
      flush();
      return w;
    },
    async verifyInstructionAckWithJev(
      paneName,
      { instruction = "", recentOutput = "" } = {},
      jevOptions = {},
    ) {
      const verdict = await judgeInstructionAck(
        { instruction, recentOutput },
        jevOptions,
      );
      if (!verdict) return null;
      this.recordInstructionAck(paneName, {
        ackStatus: verdict.ackStatus,
        semanticState: verdict.acknowledged
          ? "following_instruction"
          : "unverified_instruction",
        confidence: verdict.confidence,
      });
      return verdict;
    },
  };
}
