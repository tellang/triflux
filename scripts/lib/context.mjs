/**
 * 요청별 로그 컨텍스트 전파 (AsyncLocalStorage 기반).
 *
 * Hub HTTP 서버의 요청마다 correlationId를 자동 할당하여,
 * 하나의 요청에서 발생한 모든 로그를 추적할 수 있다.
 *
 * 사용법:
 *   import { getLogger, getCorrelationId, withRequestContext } from './lib/context.mjs';
 *
 *   // 미들웨어에서 컨텍스트 생성
 *   withRequestContext({ method: 'POST', path: '/bridge/result' }, () => {
 *     const log = getLogger();
 *     log.info({ agentId }, 'bridge.result_received');
 *   });
 *
 *   // 내부 함수에서 자동 상관 ID
 *   function processResult() {
 *     const log = getLogger();
 *     log.info('result.processed'); // correlationId 자동 포함
 *   }
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { logger } from "./logger.mjs";

/** @type {AsyncLocalStorage<{logger: import('pino').Logger, correlationId: string}>} */
export const asyncLocalStorage = new AsyncLocalStorage();

/**
 * 현재 요청 컨텍스트의 로거를 반환한다.
 * 요청 컨텍스트 밖에서 호출하면 기본 로거를 반환한다.
 *
 * @returns {import('pino').Logger}
 */
export function getLogger() {
  return asyncLocalStorage.getStore()?.logger || logger;
}

/**
 * 현재 요청의 상관 ID를 반환한다.
 *
 * @returns {string|undefined}
 */
export function getCorrelationId() {
  return asyncLocalStorage.getStore()?.correlationId;
}

/**
 * 요청 컨텍스트를 생성하고 콜백을 실행한다.
 *
 * @param {object} context — 컨텍스트 필드 (method, path 등)
 * @param {string} [context.correlationId] — 외부에서 전달된 상관 ID (없으면 자동 생성)
 * @param {function} callback — 컨텍스트 내에서 실행할 함수
 * @returns {*}
 */
export function withRequestContext(context, callback) {
  const correlationId = context.correlationId || randomUUID();
  const { correlationId: _, ...rest } = context;

  const store = {
    correlationId,
    logger: logger.child({ correlationId, ...rest }),
  };

  return asyncLocalStorage.run(store, callback);
}
