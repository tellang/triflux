import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compileRules, loadRules, matchRules, resolveConflicts } from "../lib/keyword-rules.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..", "..");
const rulesPath = join(projectRoot, "hooks", "keyword-rules.json");
const detectorScriptPath = join(projectRoot, "scripts", "keyword-detector.mjs");

// keyword-detector는 import 시 main()이 실행되므로, 테스트 로딩 단계에서만 안전하게 비활성화한다.
const previousDisable = process.env.TRIFLUX_DISABLE_MAGICWORDS;
const previousLog = console.log;
process.env.TRIFLUX_DISABLE_MAGICWORDS = "1";
console.log = () => {};
const detectorModule = await import("../keyword-detector.mjs");
console.log = previousLog;
if (previousDisable === undefined) {
  delete process.env.TRIFLUX_DISABLE_MAGICWORDS;
} else {
  process.env.TRIFLUX_DISABLE_MAGICWORDS = previousDisable;
}

const { extractPrompt, sanitizeForKeywordDetection } = detectorModule;

function loadCompiledRules() {
  const rules = loadRules(rulesPath);
  assert.equal(rules.length, 23);
  return compileRules(rules);
}

function runDetector(prompt) {
  const payload = { prompt, cwd: projectRoot };
  const result = spawnSync(process.execPath, [detectorScriptPath], {
    input: JSON.stringify(payload),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim(), "keyword-detector 출력이 비어 있습니다.");
  return JSON.parse(result.stdout.trim());
}

test("extractPrompt: prompt/message.content/parts[].text 우선순위", () => {
  assert.equal(
    extractPrompt({
      prompt: "from prompt",
      message: { content: "from message" },
      parts: [{ text: "from parts" }]
    }),
    "from prompt"
  );

  assert.equal(
    extractPrompt({
      prompt: "   ",
      message: { content: "from message" },
      parts: [{ text: "from parts" }]
    }),
    "from message"
  );

  assert.equal(
    extractPrompt({
      message: { content: [{ text: "from message-part" }] },
      parts: [{ text: "from parts" }]
    }),
    "from message-part"
  );

  assert.equal(extractPrompt({ parts: [{ text: "from parts" }] }), "from parts");
});

test("sanitizeForKeywordDetection: 코드블록/URL/파일경로/XML 태그 제거", () => {
  const input = [
    "정상 문장",
    "```sh",
    "tfx multi",
    "```",
    "https://example.com/path?q=1",
    "C:\\Users\\SSAFY\\Desktop\\Projects\\tools\\triflux",
    "./hooks/keyword-rules.json",
    "<tag>jira 이슈 생성</tag>"
  ].join("\n");

  const sanitized = sanitizeForKeywordDetection(input);

  assert.ok(sanitized.includes("정상 문장"));
  assert.ok(!sanitized.includes("tfx multi"));
  assert.ok(!sanitized.includes("https://"));
  assert.ok(!sanitized.includes("C:\\Users\\"));
  assert.ok(!sanitized.includes("./hooks/keyword-rules.json"));
  assert.ok(!sanitized.includes("<tag>"));
  assert.ok(!sanitized.includes("jira 이슈 생성"));
});

test("loadRules: 유효한 JSON 로드", () => {
  const rules = loadRules(rulesPath);
  assert.equal(rules.length, 23);
  assert.equal(rules.filter((rule) => rule.skill).length, 10);
  assert.equal(rules.filter((rule) => rule.mcp_route).length, 10);
});

test("loadRules: 잘못된 파일 처리", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "triflux-rules-"));
  const invalidPath = join(tempDir, "invalid.json");
  writeFileSync(invalidPath, "{ invalid json", "utf8");

  const malformed = loadRules(invalidPath);
  const missing = loadRules(join(tempDir, "missing.json"));

  assert.deepEqual(malformed, []);
  assert.deepEqual(missing, []);

  rmSync(tempDir, { recursive: true, force: true });
});

test("compileRules: 정규식 컴파일 성공", () => {
  const rules = loadRules(rulesPath);
  const compiled = compileRules(rules);
  assert.equal(compiled.length, 23);
  for (const rule of compiled) {
    assert.ok(Array.isArray(rule.compiledPatterns));
    assert.ok(rule.compiledPatterns.length > 0);
    for (const pattern of rule.compiledPatterns) {
      assert.ok(pattern instanceof RegExp);
    }
  }
});

test("compileRules: 정규식 컴파일 실패", () => {
  const compiled = compileRules([
    {
      id: "bad-pattern",
      priority: 1,
      patterns: [{ source: "[", flags: "" }],
      skill: "tfx-multi",
      supersedes: [],
      exclusive: false,
      state: null,
      mcp_route: null
    }
  ]);

  assert.deepEqual(compiled, []);
});

test("matchRules: tfx 키워드 매칭", () => {
  const compiledRules = loadCompiledRules();
  const cases = [
    { text: "tfx multi 세션 시작", expectedId: "tfx-multi" },
    { text: "tfx auto 돌려줘", expectedId: "tfx-auto" },
    { text: "tfx codex 로 실행", expectedId: "tfx-codex" },
    { text: "tfx gemini 로 실행", expectedId: "tfx-gemini" },
    { text: "canceltfx", expectedId: "tfx-cancel" }
  ];

  for (const { text, expectedId } of cases) {
    const clean = sanitizeForKeywordDetection(text);
    const matches = matchRules(compiledRules, clean);
    assert.ok(matches.some((match) => match.id === expectedId), `${text} => ${expectedId} 미매칭`);
  }
});

test("matchRules: MCP 라우팅 매칭", () => {
  const compiledRules = loadCompiledRules();
  const cases = [
    { text: "노션 페이지 조회해줘", expectedId: "notion-route", expectedRoute: "gemini" },
    { text: "jira 이슈 생성", expectedId: "jira-route", expectedRoute: "codex" },
    { text: "크롬 열고 로그인", expectedId: "chrome-route", expectedRoute: "gemini" },
    { text: "이메일 보내줘", expectedId: "mail-route", expectedRoute: "gemini" },
    { text: "캘린더 일정 생성", expectedId: "calendar-route", expectedRoute: "gemini" },
    { text: "playwright 테스트 작성", expectedId: "playwright-route", expectedRoute: "gemini" },
    { text: "canva 디자인 생성", expectedId: "canva-route", expectedRoute: "gemini" }
  ];

  for (const { text, expectedId, expectedRoute } of cases) {
    const matches = matchRules(compiledRules, sanitizeForKeywordDetection(text));
    const matched = matches.find((match) => match.id === expectedId);
    assert.ok(matched, `${text} => ${expectedId} 미매칭`);
    assert.equal(matched.mcp_route, expectedRoute);
  }
});

test("matchRules: 일반 대화는 매칭 없음", () => {
  const compiledRules = loadCompiledRules();
  const matches = matchRules(compiledRules, sanitizeForKeywordDetection("오늘 점심 메뉴 추천해줘"));
  assert.deepEqual(matches, []);
});

test("resolveConflicts: priority 정렬 및 supersedes 처리", () => {
  const resolved = resolveConflicts([
    { id: "rule-c", priority: 3, supersedes: [], exclusive: false },
    { id: "rule-b", priority: 2, supersedes: ["rule-c"], exclusive: false },
    { id: "rule-a", priority: 1, supersedes: [], exclusive: false },
    { id: "rule-a", priority: 1, supersedes: [], exclusive: false }
  ]);

  assert.deepEqual(
    resolved.map((rule) => rule.id),
    ["rule-a", "rule-b"]
  );
});

test("resolveConflicts: exclusive 처리", () => {
  const resolved = resolveConflicts([
    { id: "normal", priority: 1, supersedes: [], exclusive: false },
    { id: "exclusive", priority: 0, supersedes: [], exclusive: true },
    { id: "later", priority: 2, supersedes: [], exclusive: false }
  ]);

  assert.deepEqual(resolved.map((rule) => rule.id), ["exclusive"]);
});

test("코드블록 내 키워드: sanitize 후 매칭 안 됨", () => {
  const compiledRules = loadCompiledRules();
  const input = ["```txt", "tfx multi", "jira 이슈 생성", "```"].join("\n");
  const clean = sanitizeForKeywordDetection(input);
  const matches = matchRules(compiledRules, clean);
  assert.deepEqual(matches, []);
});

test("OMC 키워드와 triflux 키워드 비간섭 + TRIFLUX 네임스페이스", () => {
  const omcLike = runDetector("my tfx multi 세션 보여줘");
  assert.equal(omcLike.suppressOutput, true);

  const triflux = runDetector("tfx multi 세션 시작");
  const additionalContext = triflux?.hookSpecificOutput?.additionalContext || "";
  assert.match(additionalContext, /^\[TRIFLUX MAGIC KEYWORD: tfx-multi\]/);
});
