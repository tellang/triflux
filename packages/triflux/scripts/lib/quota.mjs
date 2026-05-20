export const QUOTA_PATTERNS = [
  /usage limit exceeded/i,
  /rate limit exceeded/i,
  /rate limit reached/i,
  /try again at/i,
  /purchase more credits/i,
  /quota exceeded/i,
  /RESOURCE_EXHAUSTED/i,
  /rateLimitExceeded/i,
  /Too Many Requests/i,
  /rate_limit_error/i,
  /overloaded_error/i,
  /insufficient_quota/i,
];

export class QuotaStreamBuffer {
  constructor({ maxBytes = 65536 } = {}) {
    this.maxBytes = maxBytes;
    this.text = "";
  }

  push(chunk) {
    this.text += Buffer.isBuffer(chunk)
      ? chunk.toString("utf8")
      : String(chunk);
    if (this.text.length > this.maxBytes) {
      this.text = this.text.slice(-this.maxBytes);
    }
    return detectQuotaText(this.text);
  }
}

export function detectQuotaText(text = "") {
  return QUOTA_PATTERNS.some((pattern) => pattern.test(text));
}

export function getRerouteTarget(cliType) {
  switch (cliType) {
    case "codex":
    case "gemini":
      return "antigravity";
    case "antigravity":
      return "codex";
    default:
      return null;
  }
}
