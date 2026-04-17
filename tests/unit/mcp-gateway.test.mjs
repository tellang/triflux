// tests/unit/mcp-gateway.test.mjs — mcp-gateway-* 스크립트 단위 테스트

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// ── 동적 임포트: start.mjs와 config.mjs는 main()을 즉시 실행하므로
//   process.argv를 패치하여 main 분기를 건너뛴다.
const _origArgv = process.argv.slice();

// ── 소스 경로 ──
const ROOT = join(process.cwd());
const START_PATH = join(ROOT, "scripts", "mcp-gateway-start.mjs");
const CONFIG_PATH = join(ROOT, "scripts", "mcp-gateway-config.mjs");
const VERIFY_PATH = join(ROOT, "scripts", "mcp-gateway-verify.mjs");

// ── SERVERS / GATEWAY_SERVERS 로드 ──
// mcp-gateway-start.mjs는 flag === '--stop' / '--status' 이외엔 startAll()을 실행한다.
// process.argv[2]를 --status 이외의 값으로 설정하면 startAll()이 호출돼 외부 명령을 실행하므로,
// 안전하게 파일을 직접 파싱하는 방식으로 배열을 추출한다.

function parseServersFromSource(filePath, varName) {
  const src = readFileSync(filePath, "utf8");
  // "const SERVERS = [" 또는 "export const GATEWAY_SERVERS = [" 블록을 추출
  const startIdx = src.indexOf(`${varName} = [`);
  if (startIdx === -1) throw new Error(`${varName} not found in ${filePath}`);
  // 닫는 '];' 위치 탐색
  const endIdx = src.indexOf("];", startIdx);
  if (endIdx === -1) throw new Error(`Closing ]; not found for ${varName}`);
  const block = src.slice(startIdx + varName.length + 3, endIdx); // "= [" 이후 ~ "]" 이전

  // 각 줄에서 name과 port를 간단히 정규식으로 추출
  const entries = [];
  const lineRe = /name:\s*["']([^"']+)["'].*?port:\s*(\d+)/gs;
  let m;
  while ((m = lineRe.exec(block)) !== null) {
    entries.push({ name: m[1], port: parseInt(m[2], 10) });
  }
  return entries;
}

function parseStdioCmdsFromSource(filePath) {
  const src = readFileSync(filePath, "utf8");
  const results = [];
  const re =
    /name:\s*["']([^"']+)["'].*?port:\s*(\d+).*?stdioCmd:\s*\n?\s*["']([^"']+)["']/gs;
  let m;
  while ((m = re.exec(src)) !== null) {
    results.push({ name: m[1], port: parseInt(m[2], 10), stdioCmd: m[3] });
  }
  return results;
}

// ── loadManifest 로직 미러 (mcp-gateway-start.mjs와 동일) ──
function loadManifest(pidFile) {
  if (!existsSync(pidFile)) return [];
  try {
    return JSON.parse(readFileSync(pidFile, "utf8"));
  } catch {
    return [];
  }
}

// ── isPortInUse 로직 미러 (mcp-gateway-start.mjs와 동일) ──
import { createConnection } from "node:net";

function isPortInUse(port) {
  return new Promise((resolve) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
    sock.setTimeout(1000, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

// ─────────────────────────────────────────────
// 1. 포트 일관성 — SERVERS vs GATEWAY_SERVERS
// ─────────────────────────────────────────────
describe("port consistency across files", () => {
  const servers = parseServersFromSource(START_PATH, "SERVERS");
  const gateways = parseServersFromSource(CONFIG_PATH, "GATEWAY_SERVERS");

  it("SERVERS and GATEWAY_SERVERS have the same number of entries", () => {
    assert.strictEqual(servers.length, gateways.length);
  });

  it("every SERVERS name exists in GATEWAY_SERVERS", () => {
    const gwNames = new Set(gateways.map((g) => g.name));
    for (const s of servers) {
      assert.ok(
        gwNames.has(s.name),
        `name '${s.name}' missing from GATEWAY_SERVERS`,
      );
    }
  });

  it("every GATEWAY_SERVERS name exists in SERVERS", () => {
    const srvNames = new Set(servers.map((s) => s.name));
    for (const g of gateways) {
      assert.ok(srvNames.has(g.name), `name '${g.name}' missing from SERVERS`);
    }
  });

  it("ports match between SERVERS and GATEWAY_SERVERS for each name", () => {
    const gwByName = Object.fromEntries(gateways.map((g) => [g.name, g.port]));
    for (const s of servers) {
      assert.strictEqual(
        s.port,
        gwByName[s.name],
        `port mismatch for '${s.name}': start=${s.port}, config=${gwByName[s.name]}`,
      );
    }
  });

  it("all ports are in the 8100-8107 range", () => {
    for (const s of servers) {
      assert.ok(
        s.port >= 8100 && s.port <= 8107,
        `port ${s.port} out of range for '${s.name}'`,
      );
    }
    for (const g of gateways) {
      assert.ok(
        g.port >= 8100 && g.port <= 8107,
        `port ${g.port} out of range for '${g.name}'`,
      );
    }
  });

  it("no duplicate ports in SERVERS", () => {
    const ports = servers.map((s) => s.port);
    const unique = new Set(ports);
    assert.strictEqual(
      unique.size,
      ports.length,
      "duplicate ports found in SERVERS",
    );
  });

  it("no duplicate ports in GATEWAY_SERVERS", () => {
    const ports = gateways.map((g) => g.port);
    const unique = new Set(ports);
    assert.strictEqual(
      unique.size,
      ports.length,
      "duplicate ports found in GATEWAY_SERVERS",
    );
  });
});

// ─────────────────────────────────────────────
// 2. SERVERS vs ENDPOINTS (verify.mjs) 일관성
// ─────────────────────────────────────────────
describe("port consistency: SERVERS vs verify ENDPOINTS", () => {
  const servers = parseServersFromSource(START_PATH, "SERVERS");
  const endpoints = parseServersFromSource(VERIFY_PATH, "ENDPOINTS");

  it("ENDPOINTS count matches SERVERS count", () => {
    assert.strictEqual(endpoints.length, servers.length);
  });

  it("every SERVERS name exists in ENDPOINTS", () => {
    const epNames = new Set(endpoints.map((e) => e.name));
    for (const s of servers) {
      assert.ok(epNames.has(s.name), `name '${s.name}' missing from ENDPOINTS`);
    }
  });

  it("ports match between SERVERS and ENDPOINTS for each name", () => {
    const epByName = Object.fromEntries(endpoints.map((e) => [e.name, e.port]));
    for (const s of servers) {
      assert.strictEqual(
        s.port,
        epByName[s.name],
        `port mismatch for '${s.name}': start=${s.port}, verify=${epByName[s.name]}`,
      );
    }
  });
});

// ─────────────────────────────────────────────
// 3. isPortInUse() — 미러 로직 테스트
// ─────────────────────────────────────────────
describe("isPortInUse", () => {
  let server;
  let boundPort;

  before(async () => {
    // 임의 포트에 TCP 서버를 바인딩하여 "listening" 상태를 만든다
    server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    boundPort = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("returns true for a port that is listening", async () => {
    const result = await isPortInUse(boundPort);
    assert.strictEqual(result, true);
  });

  it("returns false for a port that is not listening", async () => {
    // 포트 1 은 bind되지 않는다; 임의의 높은 미사용 포트를 고른다
    // server가 닫힌 후의 포트를 재사용
    const unusedPort = Math.min(boundPort + 1000, 65530);
    const result = await isPortInUse(unusedPort);
    assert.strictEqual(result, false);
  });
});

// ─────────────────────────────────────────────
// 4. loadManifest() — 미러 로직 테스트
// ─────────────────────────────────────────────
describe("loadManifest", () => {
  const testDir = join(tmpdir(), `tfx-gateway-test-${process.pid}`);
  const pidFile = join(testDir, "tfx-gateway-pids-test.json");

  before(() => {
    mkdirSync(testDir, { recursive: true });
  });

  after(() => {
    try {
      unlinkSync(pidFile);
    } catch {
      /* 무시 */
    }
  });

  it("returns empty array when pid file does not exist", () => {
    // 파일 없음을 보장
    try {
      unlinkSync(pidFile);
    } catch {
      /* 이미 없음 */
    }
    const result = loadManifest(pidFile);
    assert.deepStrictEqual(result, []);
  });

  it("returns parsed array for valid JSON file", () => {
    const data = [
      { name: "context7", port: 8100 },
      { name: "exa", port: 8102 },
    ];
    writeFileSync(pidFile, JSON.stringify(data));
    const result = loadManifest(pidFile);
    assert.deepStrictEqual(result, data);
  });

  it("returns empty array for invalid JSON content", () => {
    writeFileSync(pidFile, "{ not valid json ]]]");
    const result = loadManifest(pidFile);
    assert.deepStrictEqual(result, []);
  });

  it("returns empty array for empty file", () => {
    writeFileSync(pidFile, "");
    const result = loadManifest(pidFile);
    assert.deepStrictEqual(result, []);
  });

  it("returns empty array for file containing only whitespace", () => {
    writeFileSync(pidFile, "   \n  ");
    const result = loadManifest(pidFile);
    assert.deepStrictEqual(result, []);
  });
});

// ─────────────────────────────────────────────
// 5. GATEWAY_SERVERS — stdioCmd 필드 무결성
// ─────────────────────────────────────────────
describe("GATEWAY_SERVERS stdioCmd fields", () => {
  const entries = parseStdioCmdsFromSource(CONFIG_PATH);

  it("all GATEWAY_SERVERS entries have a stdioCmd field", () => {
    assert.ok(entries.length > 0, "No entries parsed from GATEWAY_SERVERS");
    for (const e of entries) {
      assert.ok(
        typeof e.stdioCmd === "string" && e.stdioCmd.length > 0,
        `stdioCmd is missing or empty for '${e.name}'`,
      );
    }
  });

  it("stdioCmd for context7 references the correct npm package", () => {
    const entry = entries.find((e) => e.name === "context7");
    assert.ok(entry, "context7 entry not found");
    assert.ok(
      entry.stdioCmd.includes("context7-mcp"),
      "context7 stdioCmd should reference context7-mcp",
    );
  });

  it("stdioCmd for serena uses uvx (not npx)", () => {
    const entry = entries.find((e) => e.name === "serena");
    assert.ok(entry, "serena entry not found");
    assert.ok(
      entry.stdioCmd.startsWith("uvx"),
      `serena stdioCmd should start with uvx, got: ${entry.stdioCmd}`,
    );
  });

  it("stdioCmd for notion and notion-guest reference the same package", () => {
    const notion = entries.find((e) => e.name === "notion");
    const notionGuest = entries.find((e) => e.name === "notion-guest");
    assert.ok(notion, "notion entry not found");
    assert.ok(notionGuest, "notion-guest entry not found");
    // Both should share the same underlying package
    const pkg = "@notionhq/notion-mcp-server";
    assert.ok(
      notion.stdioCmd.includes(pkg),
      `notion stdioCmd should reference ${pkg}`,
    );
    assert.ok(
      notionGuest.stdioCmd.includes(pkg),
      `notion-guest stdioCmd should reference ${pkg}`,
    );
  });

  it("no stdioCmd is an empty string", () => {
    for (const e of entries) {
      assert.notStrictEqual(
        e.stdioCmd.trim(),
        "",
        `stdioCmd is blank for '${e.name}'`,
      );
    }
  });
});

// ─────────────────────────────────────────────
// 6. 소스 파일 구조 무결성 검사
// ─────────────────────────────────────────────
describe("source file structural integrity", () => {
  it("mcp-gateway-start.mjs exports SERVERS", () => {
    const src = readFileSync(START_PATH, "utf8");
    assert.ok(
      src.includes("export { SERVERS }"),
      "SERVERS must be exported from start.mjs",
    );
  });

  it("mcp-gateway-config.mjs exports GATEWAY_SERVERS", () => {
    const src = readFileSync(CONFIG_PATH, "utf8");
    assert.ok(
      src.includes("export const GATEWAY_SERVERS"),
      "GATEWAY_SERVERS must be exported from config.mjs",
    );
  });

  it("mcp-gateway-start.mjs defines isPortInUse function", () => {
    const src = readFileSync(START_PATH, "utf8");
    assert.ok(
      src.includes("function isPortInUse"),
      "isPortInUse must be defined in start.mjs",
    );
  });

  it("mcp-gateway-start.mjs defines loadManifest function", () => {
    const src = readFileSync(START_PATH, "utf8");
    assert.ok(
      src.includes("function loadManifest"),
      "loadManifest must be defined in start.mjs",
    );
  });

  it("mcp-gateway-verify.mjs defines ENDPOINTS constant", () => {
    const src = readFileSync(VERIFY_PATH, "utf8");
    assert.ok(
      src.includes("const ENDPOINTS"),
      "ENDPOINTS must be defined in verify.mjs",
    );
  });

  it("mcp-gateway-start.mjs PID_FILE uses tmpdir", () => {
    const src = readFileSync(START_PATH, "utf8");
    assert.ok(src.includes("tmpdir()"), "PID_FILE path should use tmpdir()");
    assert.ok(
      src.includes("tfx-gateway-pids.json"),
      "PID_FILE should be named tfx-gateway-pids.json",
    );
  });

  it("mcp-gateway-start.mjs loadManifest handles missing file by returning []", () => {
    const src = readFileSync(START_PATH, "utf8");
    // 반드시 existsSync 가드와 catch [] 반환이 존재해야 한다
    assert.ok(
      src.includes("existsSync(PID_FILE)"),
      "loadManifest must guard with existsSync",
    );
    assert.ok(
      src.includes("return []"),
      "loadManifest must return [] on error/missing",
    );
  });
});
