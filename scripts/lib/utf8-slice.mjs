#!/usr/bin/env node
// UTF-8 코드포인트 경계를 보존하는 바이트 단위 슬라이서.
// 멀티바이트 시퀀스 중간을 잘라 U+FFFD 대체 문자가 생기는 문제를 막는다.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DEFAULT_MAX_STDOUT_BYTES = 16 * 1024 * 1024;

function expectedUtf8SeqLength(leadByte) {
  if ((leadByte & 0x80) === 0) return 1;
  if ((leadByte & 0xe0) === 0xc0) return 2;
  if ((leadByte & 0xf0) === 0xe0) return 3;
  if ((leadByte & 0xf8) === 0xf0) return 4;
  return 0;
}

function isContinuationByte(byte) {
  return (byte & 0xc0) === 0x80;
}

// maxBytes 가 0 이하이거나 유한하지 않으면 자르지 않는다.
export function sliceUtf8ByBytes(input, maxBytes, { from = "start" } = {}) {
  const str = typeof input === "string" ? input : String(input ?? "");
  const buf = Buffer.from(str, "utf8");
  const rawBytes = buf.length;

  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    return {
      text: str,
      truncated: false,
      rawBytes,
      outputBytes: rawBytes,
    };
  }

  const limit = Math.trunc(maxBytes);
  if (limit === 0) {
    return {
      text: "",
      truncated: rawBytes > 0,
      rawBytes,
      outputBytes: 0,
    };
  }

  if (rawBytes <= limit) {
    return {
      text: str,
      truncated: false,
      rawBytes,
      outputBytes: rawBytes,
    };
  }

  if (from === "end") {
    let start = rawBytes - limit;
    while (start < rawBytes && isContinuationByte(buf[start])) {
      start += 1;
    }
    // 비정상 leading byte로 끝 부분 시퀀스가 완성되지 않은 경우도 방어한다.
    let end = rawBytes;
    let lead = end - 1;
    while (lead >= start && lead >= end - 4 && isContinuationByte(buf[lead])) {
      lead -= 1;
    }
    if (lead >= start && lead >= end - 4) {
      const seqLen = expectedUtf8SeqLength(buf[lead]);
      if (seqLen === 0 || lead + seqLen > end) {
        end = lead;
      }
    }
    const sub = buf.subarray(start, end);
    return {
      text: sub.toString("utf8"),
      truncated: true,
      rawBytes,
      outputBytes: sub.length,
    };
  }

  let end = limit;
  let lead = end - 1;
  while (lead >= 0 && lead >= end - 4 && isContinuationByte(buf[lead])) {
    lead -= 1;
  }
  if (lead >= 0 && lead >= end - 4) {
    const seqLen = expectedUtf8SeqLength(buf[lead]);
    if (seqLen === 0 || lead + seqLen > end) {
      end = lead;
    }
  }
  // 선두에 고립된 continuation 바이트만 남은 비정상 입력 방어
  let start = 0;
  while (start < end && isContinuationByte(buf[start])) {
    start += 1;
  }
  const sub = buf.subarray(start, end);
  return {
    text: sub.toString("utf8"),
    truncated: true,
    rawBytes,
    outputBytes: sub.length,
  };
}

function runCli(argv = process.argv.slice(2)) {
  let filePath = "";
  let maxBytes = 32768;
  let from = "start";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file") {
      filePath = argv[i + 1] || "";
      i += 1;
    } else if (arg === "--max-bytes") {
      maxBytes = Number.parseInt(argv[i + 1] || "0", 10);
      i += 1;
    } else if (arg === "--from") {
      from = argv[i + 1] === "end" ? "end" : "start";
      i += 1;
    }
  }
  const raw = filePath ? readFileSync(filePath, "utf8") : "";
  const sliced = sliceUtf8ByBytes(raw, maxBytes, { from });
  process.stdout.write(sliced.text);
}

const _isEvalInvocation = process.execArgv.some(
  (arg) => arg === "-e" || arg === "--eval" || arg.startsWith("--eval="),
);
if (
  !_isEvalInvocation &&
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  runCli();
}
