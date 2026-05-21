import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkMcpGatewayHealth,
  summarizeMcpGatewayHealth,
} from "../lib/mcp-gateway-health-check.mjs";

function makeFs({ logBody = null, statError = null, readError = null } = {}) {
  return {
    statSync(path) {
      if (statError) throw statError;
      if (logBody == null) {
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      return { path, size: logBody.length };
    },
    readFileSync(path, encoding) {
      if (readError) throw readError;
      assert.equal(encoding, "utf8");
      return logBody ?? "";
    },
  };
}

const HEALTHY_LOG = `[START] brave-search on :8101
[SKIP] context7 already running on :8100
[SKIP] exa — manifest에서 비활성
[SKIP] tavily — manifest에서 비활성
[SKIP] jira — manifest에서 비활성
[START] serena on :8105
[SKIP] notion — manifest에서 비활성
[SKIP] notion-guest — manifest에서 비활성

[gateway] Waiting for 2 servers...

Health Check
==================================================
  brave-search     :8101  ✓ ok
  serena           :8105  ✓ ok

[gateway] 2/2 healthy.
`;

const MISSING_ENV_LOG = `[SKIP] context7 already running on :8100
[WARN] brave-search skipped — missing env: BRAVE_API_KEY
[SKIP] exa — manifest에서 비활성
[SKIP] tavily — manifest에서 비활성
[SKIP] jira — manifest에서 비활성
[START] serena on :8105
[SKIP] notion — manifest에서 비활성
[SKIP] notion-guest — manifest에서 비활성

[gateway] Waiting for 1 servers...

Health Check
==================================================
  serena           :8105  ✓ ok

[gateway] 1/1 healthy.
`;

describe("mcp-gateway-health-check", () => {
  it("log 파일이 없으면 available=false 로 침묵한다", () => {
    const result = checkMcpGatewayHealth({
      fs: makeFs(),
      logPath: "/tmp/nonexistent-mcp-gateway.out.log",
    });
    assert.equal(result.available, false);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.started, []);
    assert.deepEqual(result.skipped, []);
  });

  it("정상 로그는 findings 가 비고 started 만 채워진다", () => {
    const result = checkMcpGatewayHealth({
      fs: makeFs({ logBody: HEALTHY_LOG }),
      logPath: "/fake/log",
    });
    assert.equal(result.available, true);
    assert.equal(result.findings.length, 0);
    const started = result.started.map((s) => s.server).sort();
    assert.deepEqual(started, ["brave-search", "context7", "serena"]);
    const preExisting = result.started.find((s) => s.preExisting);
    assert.equal(preExisting.server, "context7");
    assert.equal(preExisting.port, 8100);
    const skipped = result.skipped.map((s) => s.server).sort();
    assert.deepEqual(skipped, [
      "exa",
      "jira",
      "notion",
      "notion-guest",
      "tavily",
    ]);
  });

  it("missing env 로그를 finding 으로 잡는다", () => {
    const result = checkMcpGatewayHealth({
      fs: makeFs({ logBody: MISSING_ENV_LOG }),
      logPath: "/fake/log",
    });
    assert.equal(result.available, true);
    assert.equal(result.findings.length, 1);
    assert.deepEqual(result.findings[0], {
      server: "brave-search",
      reason: "missing-env",
      detail: "BRAVE_API_KEY",
    });
    const started = result.started.map((s) => s.server).sort();
    assert.deepEqual(started, ["context7", "serena"]);
  });

  it("다중 env 가 누락된 [WARN] (예: jira) 도 캡처한다", () => {
    const multiEnvLog = `[SKIP] context7 already running on :8100
[WARN] jira skipped — missing env: JIRA_API_TOKEN, JIRA_EMAIL, JIRA_INSTANCE_URL
[START] serena on :8105
`;
    const result = checkMcpGatewayHealth({
      fs: makeFs({ logBody: multiEnvLog }),
      logPath: "/fake/log",
    });
    assert.equal(result.findings.length, 1);
    assert.deepEqual(result.findings[0], {
      server: "jira",
      reason: "missing-env",
      detail: "JIRA_API_TOKEN, JIRA_EMAIL, JIRA_INSTANCE_URL",
    });
    const summary = summarizeMcpGatewayHealth(result);
    assert.equal(summary.level, "warn");
    assert.match(summary.message, /jira/);
    assert.match(
      summary.message,
      /JIRA_API_TOKEN, JIRA_EMAIL, JIRA_INSTANCE_URL/,
    );
  });

  it("read 에러는 log-read-error finding 으로 보고한다", () => {
    const fs = makeFs({ logBody: "" });
    fs.readFileSync = () => {
      throw new Error("EACCES: permission denied");
    };
    const result = checkMcpGatewayHealth({ fs, logPath: "/fake/log" });
    assert.equal(result.available, true);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].reason, "log-read-error");
    assert.match(result.findings[0].detail, /EACCES/);
  });

  it("summarize: 로그 없음 → skip", () => {
    const summary = summarizeMcpGatewayHealth(
      checkMcpGatewayHealth({
        fs: makeFs(),
        logPath: "/fake/log",
      }),
    );
    assert.equal(summary.level, "skip");
  });

  it("summarize: missing-env → warn + fix hint", () => {
    const summary = summarizeMcpGatewayHealth(
      checkMcpGatewayHealth({
        fs: makeFs({ logBody: MISSING_ENV_LOG }),
        logPath: "/fake/log",
      }),
    );
    assert.equal(summary.level, "warn");
    assert.match(summary.message, /brave-search/);
    assert.match(summary.message, /BRAVE_API_KEY/);
    assert.match(summary.fix, /secrets\.env/);
  });

  it("옛 [WARN] 뒤에 [START] 가 오면 server 가 복구된 것으로 본다", () => {
    const recoveredLog = `[WARN] brave-search skipped — missing env: BRAVE_API_KEY
[SKIP] context7 already running on :8100
[SKIP] serena already running on :8105

# (사용자가 secrets.env 추가 후 launchctl kickstart)

[START] brave-search on :8101
[SKIP] context7 already running on :8100
[SKIP] serena already running on :8105
`;
    const result = checkMcpGatewayHealth({
      fs: makeFs({ logBody: recoveredLog }),
      logPath: "/fake/log",
    });
    assert.equal(result.findings.length, 0, "복구된 server 는 finding 에서 빠진다");
    const startedNames = result.started.map((s) => s.server).sort();
    assert.deepEqual(startedNames, ["brave-search", "context7", "serena"]);
  });

  it("summarize: 정상 → ok", () => {
    const summary = summarizeMcpGatewayHealth(
      checkMcpGatewayHealth({
        fs: makeFs({ logBody: HEALTHY_LOG }),
        logPath: "/fake/log",
      }),
    );
    assert.equal(summary.level, "ok");
    assert.match(summary.message, /healthy/);
  });
});
