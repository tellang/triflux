/**
 * Logify — triflux 구조화 로깅 설정
 *
 * 사용법:
 *   import { logger, createModuleLogger } from './lib/logger.mjs';
 *
 *   // 기본 로거
 *   logger.info({ taskId: 'abc' }, 'task.started');
 *
 *   // 모듈별 로거
 *   const log = createModuleLogger('hub');
 *   log.info({ port: 27888 }, 'server.started');
 *   log.error({ err }, 'server.error');
 *
 * 이벤트 네이밍: {도메인}.{액션} 형식
 *   hub.started, hub.stopped, route.started, route.completed,
 *   worker.spawned, worker.completed, worker.timeout,
 *   mcp.connected, mcp.disconnected, mcp.error,
 *   team.created, team.deleted, task.claimed, task.completed,
 *   pipe.connected, pipe.message, pipe.error,
 *   http.request, http.response, http.error
 *
 * 로그 레벨 가이드:
 *   debug  — 개발/트러블슈팅용 (변수 값, MCP 메시지, 캐시 키)
 *   info   — 정상 흐름 상태 변경 (서버 시작, 워커 완료, 팀 생성)
 *   warn   — 위험 신호 (재시도 발생, 쿼타 임박, 느린 워커)
 *   error  — 작업 실패 (CLI 실행 실패, MCP 연결 끊김)
 *   fatal  — 프로세스 위협 (DB 연결 불가, 포트 충돌)
 */
import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? "debug" : "info"),

  // 모든 로그에 포함되는 기본 필드
  base: {
    service: process.env.SERVICE_NAME || "triflux",
    env: process.env.NODE_ENV || "development",
  },

  // 레벨을 대문자로 출력 (AI 파싱 용이)
  formatters: {
    level: (label) => ({ level: label.toUpperCase() }),
  },

  // ISO 8601 타임스탬프
  timestamp: pino.stdTimeFunctions.isoTime,

  // 민감정보 자동 필터링
  redact: {
    paths: [
      "password",
      "token",
      "apiKey",
      "secret",
      "authorization",
      "*.password",
      "*.token",
      "*.apiKey",
      "*.secret",
      "req.headers.authorization",
      "req.headers.cookie",
      "hubToken",
    ],
    remove: true,
  },

  // 개발 환경: 컬러 콘솔 출력
  transport: isDev
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "yyyy-mm-dd HH:MM:ss",
          ignore: "pid,hostname",
        },
      }
    : undefined,
});

/**
 * 모듈별 Child Logger 생성.
 * 모듈 이름이 모든 로그에 자동 포함된다.
 *
 * @param {string} module — 모듈 이름 (hub, route, worker, mcp, team 등)
 * @returns {import('pino').Logger}
 */
export function createModuleLogger(module) {
  return logger.child({ module });
}

// 정상 종료 시 버퍼 flush 보장
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "process.uncaught_exception");
  logger.flush();
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.fatal({ reason: String(reason) }, "process.unhandled_rejection");
  logger.flush();
  process.exit(1);
});
