// hub/team/event-log.mjs — JSONL 블랙박스 리코더
// Conductor 세션 lifecycle 이벤트를 JSONL 파일에 기록한다.
// 기존 hub/server.mjs의 batch-events.jsonl(MCP 이벤트)과 독립. 공존.

import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * JSONL event log 팩토리.
 * @param {string} filePath — 로그 파일 경로 (.jsonl)
 * @param {object} [opts]
 * @param {string} [opts.sessionId] — 모든 이벤트에 자동 삽입할 세션 ID
 * @returns {{ append, flush, close, filePath }}
 */
export function createEventLog(filePath, opts = {}) {
  const { sessionId } = opts;

  mkdirSync(dirname(filePath), { recursive: true });
  const stream = createWriteStream(filePath, { flags: 'a' });

  let closed = false;
  let pending = 0;

  /**
   * 이벤트를 JSONL 한 줄로 기록.
   * @param {string} event — 이벤트 타입 (spawn, health, kill, stateChange, ...)
   * @param {object} [data] — 이벤트 페이로드
   */
  function append(event, data = {}) {
    if (closed) return;
    const entry = {
      ts: new Date().toISOString(),
      ...(sessionId ? { session: sessionId } : {}),
      event,
      ...data,
    };
    pending += 1;
    stream.write(JSON.stringify(entry) + '\n', () => { pending -= 1; });
  }

  /**
   * 버퍼된 이벤트를 디스크에 flush.
   * @returns {Promise<void>}
   */
  function flush() {
    if (closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      stream.once('error', reject);
      stream.write('', () => {
        stream.removeListener('error', reject);
        resolve();
      });
    });
  }

  /**
   * 스트림 종료. flush 후 close.
   * @returns {Promise<void>}
   */
  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    return new Promise((resolve) => {
      stream.end(() => resolve());
    });
  }

  return Object.freeze({
    append,
    flush,
    close,
    get filePath() { return filePath; },
    get pending() { return pending; },
    get closed() { return closed; },
  });
}
