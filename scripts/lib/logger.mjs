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

// 로그는 항상 stderr(fd 2)로 보낸다.
//
// Claude Code 훅은 stdout 을 훅의 JSON 페이로드로 파싱한다. 로그가 stdout 으로
// 나가면 페이로드와 한 스트림에 섞여, 훅이 돌려준 hookSpecificOutput 이 JSON 으로
// 해석되지 않고 그냥 본문 텍스트가 된다. Claude Code 2.1.257 부터는 stdout 이
// "{" 로 시작하는데 유효한 JSON 이 아니면 훅 오류로 보고하므로, 로그가 먼저 나가느냐
// 페이로드가 먼저 나가느냐에 따라 훅 전체가 실패로 뒤집힌다.
//
// stderr 로 보내면 Claude Code 가 verbose/transcript 에서 그대로 보여주고 stdout 은
// 페이로드만 남는다. CLI 관례상으로도 구조화 로그는 stderr 가 맞다.
const LOG_FD = 2;

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

  // 개발 환경: 컬러 콘솔 출력 (stderr)
  transport: isDev
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "yyyy-mm-dd HH:MM:ss",
          ignore: "pid,hostname",
          destination: LOG_FD,
        },
      }
    : undefined,
},
// 운영 환경(transport 미사용)에서도 stdout 이 아니라 stderr 로 쓴다.
isDev ? undefined : pino.destination({ dest: LOG_FD, sync: false }));

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
