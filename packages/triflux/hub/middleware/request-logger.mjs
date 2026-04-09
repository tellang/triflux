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

import { createContextMonitor } from "../../hud/context-monitor.mjs";
import {
  getCorrelationId,
  withRequestContext,
} from "../../scripts/lib/context.mjs";
import { createModuleLogger } from "../../scripts/lib/logger.mjs";

const log = createModuleLogger("hub");
const contextMonitor = createContextMonitor();

const SKIP_PATHS = new Set(["/health", "/healthz", "/status", "/ready"]);
const MAX_CAPTURE_BYTES = 256 * 1024;

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
      req.headers["x-correlation-id"] ||
      req.headers["x-request-id"] ||
      undefined; // withRequestContext will generate one

    withRequestContext(
      {
        correlationId,
        method: req.method,
        path,
      },
      () => {
        const startTime = process.hrtime.bigint();
        const reqChunks = [];
        let reqBytes = 0;
        let reqOverflow = false;

        req.on("data", (chunk) => {
          if (reqOverflow) return;
          const buf = Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(String(chunk));
          reqBytes += buf.length;
          if (reqBytes > MAX_CAPTURE_BYTES) {
            reqOverflow = true;
            reqChunks.length = 0;
            return;
          }
          reqChunks.push(buf);
        });

        const resChunks = [];
        let resBytes = 0;
        let resOverflow = false;

        const originalWrite = res.write.bind(res);
        const originalEnd = res.end.bind(res);

        function captureResponseChunk(chunk) {
          if (resOverflow || chunk == null) return;
          const buf = Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(String(chunk));
          resBytes += buf.length;
          if (resBytes > MAX_CAPTURE_BYTES) {
            resOverflow = true;
            resChunks.length = 0;
            return;
          }
          resChunks.push(buf);
        }

        res.write = function writePatched(chunk, ...args) {
          captureResponseChunk(chunk);
          return originalWrite(chunk, ...args);
        };

        res.end = function endPatched(chunk, ...args) {
          captureResponseChunk(chunk);
          return originalEnd(chunk, ...args);
        };

        // 응답 헤더에 상관 ID 포함
        const cid = getCorrelationId();
        if (cid) res.setHeader("X-Correlation-ID", cid);

        // 응답 완료 시 로깅
        res.on("finish", () => {
          const duration =
            Number(process.hrtime.bigint() - startTime) / 1_000_000;
          const level =
            res.statusCode >= 500
              ? "error"
              : res.statusCode >= 400
                ? "warn"
                : "info";
          const reqBodyText = reqOverflow
            ? ""
            : Buffer.concat(reqChunks).toString("utf8");
          const resBodyText = resOverflow
            ? ""
            : Buffer.concat(resChunks).toString("utf8");
          const tokenSummary = contextMonitor.record({
            requestBody: reqBodyText,
            requestBytes:
              reqBytes || Number(req.headers["content-length"] || 0),
            responseBody: resBodyText,
            responseBytes:
              resBytes || Number(res.getHeader("content-length") || 0),
          });

          log[level](
            {
              status: res.statusCode,
              duration: Math.round(duration * 100) / 100,
              contentLength: res.getHeader("content-length") || 0,
              tokenUsage: {
                request: tokenSummary.requestTokens,
                response: tokenSummary.responseTokens,
                total: tokenSummary.totalTokens,
                context: tokenSummary.display,
                warningLevel: tokenSummary.warningLevel,
                overheadMs: tokenSummary.overheadMs,
              },
            },
            "http.response",
          );

          if (tokenSummary.warningLevel === "critical") {
            log.error(
              {
                context: tokenSummary.display,
                message: tokenSummary.warningMessage,
              },
              "context.critical",
            );
          } else if (tokenSummary.warningLevel === "warn") {
            log.warn(
              {
                context: tokenSummary.display,
                message: tokenSummary.warningMessage,
              },
              "context.warn",
            );
          } else if (tokenSummary.warningLevel === "info") {
            log.info(
              {
                context: tokenSummary.display,
                message: tokenSummary.warningMessage,
              },
              "context.info",
            );
          }
        });

        handler(req, res);
      },
    );
  };
}

function getRequestPath(url = "/") {
  try {
    return new URL(url, "http://127.0.0.1").pathname;
  } catch {
    return String(url).replace(/\?.*/, "") || "/";
  }
}
