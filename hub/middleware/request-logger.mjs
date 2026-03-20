/**
 * Hub HTTP 서버 요청 로깅 미들웨어.
 *
 * raw http.createServer에 맞춘 래퍼. Express가 아닌 triflux Hub 전용.
 *
 * 사용법 (server.mjs에서):
 *   import { wrapRequestHandler } from './middleware/request-logger.mjs';
 *   const httpServer = createHttpServer(wrapRequestHandler(originalHandler));
 *
 * 각 요청에 correlationId를 할당하고, 응답 완료 시 구조화 로그를 남긴다.
 * health/status 체크는 로깅을 건너뛴다.
 */
import { withRequestContext, getCorrelationId } from '../../scripts/lib/context.mjs';
import { createModuleLogger } from '../../scripts/lib/logger.mjs';

const log = createModuleLogger('hub');

const SKIP_PATHS = new Set(['/health', '/healthz', '/status', '/ready']);

/**
 * 원본 request handler를 래핑하여 로깅 + 컨텍스트 전파를 추가한다.
 *
 * @param {function(import('http').IncomingMessage, import('http').ServerResponse): void} handler
 * @returns {function(import('http').IncomingMessage, import('http').ServerResponse): void}
 */
export function wrapRequestHandler(handler) {
  return (req, res) => {
    const path = getRequestPath(req.url);

    if (SKIP_PATHS.has(path)) {
      return handler(req, res);
    }

    const correlationId =
      req.headers['x-correlation-id'] ||
      req.headers['x-request-id'] ||
      undefined; // withRequestContext will generate one

    withRequestContext(
      {
        correlationId,
        method: req.method,
        path,
      },
      () => {
        const startTime = process.hrtime.bigint();

        // 응답 헤더에 상관 ID 포함
        const cid = getCorrelationId();
        if (cid) res.setHeader('X-Correlation-ID', cid);

        // 응답 완료 시 로깅
        res.on('finish', () => {
          const duration = Number(process.hrtime.bigint() - startTime) / 1_000_000;
          const level = res.statusCode >= 500 ? 'error'
            : res.statusCode >= 400 ? 'warn'
            : 'info';

          log[level](
            {
              status: res.statusCode,
              duration: Math.round(duration * 100) / 100,
              contentLength: res.getHeader('content-length') || 0,
            },
            'http.response',
          );
        });

        handler(req, res);
      },
    );
  };
}

function getRequestPath(url = '/') {
  try {
    return new URL(url, 'http://127.0.0.1').pathname;
  } catch {
    return String(url).replace(/\?.*/, '') || '/';
  }
}
