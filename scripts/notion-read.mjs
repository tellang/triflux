#!/usr/bin/env node
// notion-read.mjs v1.2 — Notion 대형 페이지 리더 (Codex/Gemini/Claude MCP 위임)
//
// Codex/Gemini/Claude CLI에 설치된 Notion MCP를 활용하여 대형 페이지를 마크다운으로 추출.
// 폴백 체인: Codex(무료) → Gemini(무료) → Claude(최후) → 에러
// 이관 모드(--delegate): Claude(notion-guest 우선) 단독 실행 + 결과 파일 저장
//
// 사용법:
//   node notion-read.mjs <notion-url-or-page-id> [옵션]
//   tfx notion-read <notion-url-or-page-id> [옵션]
//
// 옵션:
//   --output, -o <file>      결과 파일 저장 (기본: stdout)
//   --timeout, -t <sec>      CLI 타임아웃 (기본: 600)
//   --cli, -c <codex|gemini> CLI 강제 지정 (기본: 자동 + 폴백)
//   --depth, -d <n>          중첩 블록 최대 깊이 (기본: 3)
//   --guest                  notion-guest 통합 사용 (기본: notion)
//   --delegate               Claude 이관 모드 (notion-guest 우선, 파일 저장)

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, unlinkSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir, tmpdir } from 'os';

const VERSION = '1.2';
const CLAUDE_DIR = join(homedir(), '.claude');
const MCP_CACHE = join(CLAUDE_DIR, 'cache', 'mcp-inventory.json');
const LOG_FILE = join(CLAUDE_DIR, 'logs', 'cli-route-stats.jsonl');
const ACC_FILE = join(CLAUDE_DIR, 'cache', 'sv-accumulator.json');

// ── ANSI 색상 ──
const AMBER = '\x1b[38;5;214m';
const GREEN = '\x1b[38;5;82m';
const RED = '\x1b[38;5;196m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const GRAY = '\x1b[38;5;245m';

// ── URL 파싱 ──
function parseNotionUrl(input) {
  // 32자리 hex (하이픈 없는 page_id)
  if (/^[a-f0-9]{32}$/i.test(input)) {
    return { pageId: input, blockId: null };
  }
  // UUID 형식
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input)) {
    return { pageId: input.replace(/-/g, ""), blockId: null };
  }
  // URL에서 page_id + optional #block_id 추출
  const urlMatch = input.match(/([a-f0-9]{32})(?:#([a-f0-9]{32}))?/i);
  if (urlMatch) {
    return { pageId: urlMatch[1], blockId: urlMatch[2] || null };
  }
  return null;
}

// ── MCP 가용성 확인 ──
function getNotionMcpClis(useGuest) {
  const serverName = useGuest ? "notion-guest" : "notion";
  const result = { codex: false, gemini: false };

  if (!existsSync(MCP_CACHE)) return result;

  try {
    const inv = JSON.parse(readFileSync(MCP_CACHE, "utf8"));

    if (inv.codex?.servers) {
      result.codex = inv.codex.servers.some(
        (s) => s.name === serverName && (s.status === "enabled" || s.status === "configured"),
      );
    }
    if (inv.gemini?.servers) {
      result.gemini = inv.gemini.servers.some(
        (s) => s.name === serverName && (s.status === "enabled" || s.status === "configured"),
      );
    }
  } catch {}

  return result;
}

// ── CLI 존재 확인 ──
function cliExists(name) {
  try {
    const cmd = process.platform === "win32" ? `where ${name} 2>nul` : `which ${name} 2>/dev/null`;
    const result = execSync(cmd, { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "ignore"] });
    return !!result.trim();
  } catch {
    return false;
  }
}

// ── 프롬프트 생성 ──
function buildPrompt(pageId, blockId, depth, useGuest, includeComments) {
  const mcpServer = useGuest ? "notion-guest" : "notion";
  const targetBlock = blockId || pageId;
  const blockNote = blockId
    ? `\n시작 블록: ${blockId} — 이 블록과 그 하위 블록만 읽어라.`
    : "";

  return `Notion 페이지를 마크다운으로 추출하라.

페이지 ID: ${pageId}${blockNote}

## 실행 지침

${mcpServer} MCP 서버의 도구를 사용하라.

### 1단계: 페이지 메타데이터
페이지 조회 도구를 호출하라 (page_id: "${pageId}").
제목과 주요 속성을 기록하라.
404 에러가 나면 ${useGuest ? "notion" : "notion-guest"} 서버로 재시도하라.

### 2단계: 블록 읽기 (페이지네이션 필수)
블록 자식 조회 도구를 호출하라 (block_id: "${targetBlock}", page_size: 100).

**페이지네이션 — 반드시 수행:**
- 응답의 has_more가 true이면, next_cursor를 start_cursor로 전달하여 반복 호출.
- has_more가 false가 될 때까지 계속 반복. 대형 페이지는 5-10회 이상 필요.
- 절대 첫 페이지만 읽고 멈추지 마라.

### 3단계: 중첩 블록 재귀
각 블록의 has_children이 true이면, 해당 block_id로 블록 자식 조회를 재귀 호출.
최대 깊이: ${depth}단계. 깊이 초과 시 "[깊이 초과]" 표시.

### 4단계: 댓글 수집${includeComments ? `
페이지 및 블록 댓글을 수집하라.
- 댓글 조회 도구를 호출하라 (block_id: "${pageId}")로 페이지 전체 댓글을 가져와라.
- 응답의 has_more가 true이면 next_cursor로 반복.
- 각 댓글의 parent.type이 "block_id"이면 해당 블록의 인라인 댓글이다.
- parent.type이 "page_id"이면 페이지 레벨 토론 댓글이다.
- 404 에러 발생 시 댓글 권한이 없는 것이므로 건너뛰어라.` : `
댓글 수집을 건너뛴다 (--comments 플래그 미지정).`}

### 5단계: 마크다운 변환
- heading_1/2/3 → #/##/###
- paragraph → rich_text의 plain_text 연결
- bulleted_list_item → - 항목
- numbered_list_item → 1. 항목
- to_do → - [ ] 또는 - [x]
- toggle → **제목** + 하위 내용 들여쓰기
- code → \`\`\`언어 + 코드 + \`\`\`
- quote → > 인용
- callout → > 콜아웃
- table + table_row → 마크다운 테이블 (| 헤더 | ... |)
- image → ![](url)
- bookmark → [북마크](url)
- divider → ---
- column_list/column → 순서대로 출력
- child_page → [하위 페이지: 제목]
- child_database → [하위 DB: 제목]
- synced_block → 원본 내용 출력
- 기타 → [블록타입: 지원안됨]

### 출력 규칙
- 페이지 제목을 # 헤더로 시작
- 모든 블록을 빠짐없이 순서대로 출력
- 읽기 실패 블록은 <!-- 읽기 실패: block_id --> 주석 남기기
- rich_text의 annotations (bold, italic, code, strikethrough) 반영
- 링크는 [텍스트](url) 형식${includeComments ? `
- 블록 인라인 댓글: 해당 블록 바로 아래에 > **[댓글]** @작성자: 내용 형식으로 삽입
- 페이지 토론 댓글: 문서 맨 끝에 ## 토론 섹션으로 모아서 출력
- 댓글의 rich_text도 마크다운으로 변환` : ""}
- 최종 결과만 출력 — 중간 과정 설명 불필요`;
}

// ── CLI 실행 (임시 파일 + execSync — Windows .cmd 호환) ──
function runWithCli(cliType, prompt, timeout, runMode = 'fg') {
  const cliName = cliType === 'claude' ? 'claude' : cliType === 'codex' ? 'codex' : 'gemini';
  if (!cliExists(cliName)) {
    return { success: false, output: '', error: `${cliType} CLI 미설치`, cli: cliType };
  }

  // 프롬프트를 임시 파일에 저장 (shell escaping 회피)
  const promptFile = join(tmpdir(), `notion-prompt-${Date.now()}.md`);
  writeFileSync(promptFile, prompt, 'utf8');
  const promptPath = promptFile.replace(/\\/g, '/');

  // CLI에 전달할 짧은 메타 프롬프트
  const metaPrompt = `Read the file at ${promptPath} and execute all instructions in it exactly as described. Output only the final markdown result.`;

  let cmd;
  if (cliType === 'codex') {
    cmd = `codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check "${metaPrompt}"`;
  } else if (cliType === 'gemini') {
    cmd = `gemini -m gemini-3-flash-preview -y --allowed-mcp-server-names notion,notion-guest --prompt "${metaPrompt}"`;
  } else {
    // Claude CLI — print 모드 (MCP 도구 자동 접근)
    cmd = `claude -p "${metaPrompt}"`;
  }

  console.error(`${AMBER}▸${RESET} ${cliType}로 실행 중... (timeout: ${timeout}s)`);
  const startTime = Date.now();

  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  try {
    stdout = execSync(cmd, {
      encoding: 'utf8',
      timeout: (timeout + 30) * 1000,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.cwd(),
    });
  } catch (e) {
    exitCode = e.status || (e.killed ? 124 : 1);
    stdout = e.stdout || "";
    stderr = e.stderr || "";
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);

  // 임시 파일 정리
  try { unlinkSync(promptFile); } catch {}

  // 실행 로그 기록
  logExecution(cliType, exitCode, elapsed, timeout, stderr, runMode);

  if (exitCode === 0 && stdout) {
    return { success: true, output: stdout, cli: cliType, elapsed };
  }

  const isTimeout = exitCode === 124;
  return {
    success: false,
    output: stdout,
    error: isTimeout ? `timeout (${timeout}s)` : `exit ${exitCode}`,
    stderr: stderr.slice(-500),
    cli: cliType,
    elapsed,
  };
}

// ── Codex JSON-line 출력 정리 ──
function cleanCodexOutput(raw) {
  const lines = raw.split(/\r?\n/);
  const texts = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // JSON-line 형식이면 파싱
    if (trimmed.startsWith("{")) {
      try {
        const obj = JSON.parse(trimmed);
        if (["message", "completed", "output_text"].includes(obj.type)) {
          const text = obj.text || obj.content || obj.output || "";
          if (text) texts.push(text);
        }
        continue;
      } catch {
        // JSON 파싱 실패 → 일반 텍스트로 처리
      }
    }

    texts.push(line);
  }

  return texts.join("\n");
}

// ── 실행 로그 (cli-route.sh 호환) ──
function logExecution(cliType, exitCode, elapsed, timeout, stderr, runMode = 'fg') {
  try {
    const logDir = dirname(LOG_FILE);
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

    const ts = new Date().toISOString();
    const status = exitCode === 0 ? 'success' : exitCode === 124 ? 'timeout' : 'failed';
    const entry = JSON.stringify({
      ts,
      agent: 'notion-read',
      cli: cliType,
      effort: cliType === 'codex' ? 'high' : cliType === 'claude' ? 'sonnet' : 'flash',
      run_mode: runMode,
      opus_oversight: 'false',
      status,
      exit_code: exitCode,
      elapsed_sec: elapsed,
      timeout_sec: timeout,
      mcp_profile: runMode === 'delegate' ? 'notion-guest' : 'notion',
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    });
    appendFileSync(LOG_FILE, entry + '\n');
  } catch {}
}

// ── 메인 ──
function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
  ${AMBER}${BOLD}notion-read${RESET} ${DIM}v${VERSION}${RESET}
  ${GRAY}Notion 대형 페이지 리더 — Codex/Gemini MCP 위임${RESET}

  ${BOLD}사용법${RESET}
    tfx notion-read <notion-url-or-page-id> [옵션]

  ${BOLD}옵션${RESET}
    --output, -o <file>       결과 파일 저장 (기본: stdout)
    --timeout, -t <sec>       CLI 타임아웃 (기본: 600)
    --cli, -c <codex|gemini|claude>  CLI 강제 지정 (기본: 자동 + 폴백)
    --depth, -d <n>           중첩 블록 최대 깊이 (기본: 3)
    --comments                블록/페이지 댓글 포함
    --guest                   notion-guest 통합 사용
    --delegate                Claude 이관 모드 (notion-guest 우선, 파일 저장)

  ${BOLD}폴백 체인${RESET}
    Codex(무료) → Gemini(무료) → Claude(최후) → 에러

  ${BOLD}예시${RESET}
    tfx notion-read https://notion.so/Page-abc123def456...
    tfx notion-read abc123def456... --output page.md --comments
    tfx notion-read abc123def456... --cli gemini --timeout 900
    tfx notion-read abc123def456... --guest --comments
    tfx notion-read abc123def456... --delegate
    tfx notion-read abc123def456... --delegate --output .notion-cache/page.md
`);
    return;
  }

  // 인자 파싱
  const input = args[0];
  let outputFile = null;
  let timeout = 600;
  let forceCli = null;
  let depth = 3;
  let useGuest = false;
  let includeComments = false;
  let delegateMode = false;

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case "--output":
      case "-o":
        outputFile = args[++i];
        break;
      case "--timeout":
      case "-t":
        timeout = parseInt(args[++i]) || 600;
        break;
      case "--cli":
      case "-c":
        forceCli = args[++i];
        break;
      case "--depth":
      case "-d":
        depth = parseInt(args[++i]) || 3;
        break;
      case "--guest":
        useGuest = true;
        break;
      case "--comments":
        includeComments = true;
        break;
      case '--delegate':
        delegateMode = true;
        break;
    }
  }

  // URL 파싱
  const parsed = parseNotionUrl(input);
  if (!parsed) {
    console.error(`${RED}✗${RESET} 유효하지 않은 Notion URL/ID: ${input}`);
    process.exit(1);
  }

  console.error(
    `${AMBER}▸${RESET} 페이지: ${parsed.pageId}${parsed.blockId ? ` (블록: ${parsed.blockId})` : ""}`,
  );
  console.error(`${GRAY}  통합: ${delegateMode ? 'notion-guest(우선)' : useGuest ? 'notion-guest' : 'notion'} | 깊이: ${depth} | 댓글: ${includeComments ? 'O' : 'X'} | 타임아웃: ${timeout}s${RESET}`);

  // 프롬프트 생성
  const prompt = buildPrompt(parsed.pageId, parsed.blockId, depth, useGuest, includeComments);
  // Claude 폴백용: notion/notion-guest 양쪽 시도 프롬프트
  const claudePrompt = buildPrompt(parsed.pageId, parsed.blockId, depth, false, includeComments)
    .replace(
      'notion MCP 서버의 도구를 사용하라.',
      '가능하면 notion-guest MCP 서버를 먼저 사용하라. 실패하면 notion MCP 서버를 사용하라.',
    );

  // delegate 모드: Claude 단독 + notion-guest 우선 + 파일 저장
  if (delegateMode) {
    console.error(`${AMBER}▸${RESET} delegate 모드 활성화: Claude로 notion-guest 우선 접근`);

    const delegatePrompt = `${claudePrompt}

### delegate 모드 추가 지시
- notion-guest MCP 서버를 최우선으로 먼저 시도하라.
- notion-guest가 실패하거나 미구성일 때만 notion 서버로 폴백하라.
- 도구 호출 결과를 바탕으로 최종 마크다운만 출력하라.`;

    const delegateResult = runWithCli('claude', delegatePrompt, timeout, 'delegate');
    if (!delegateResult.success) {
      console.error(`${RED}✗${RESET} delegate 모드 실패: ${delegateResult.error}`);
      if (delegateResult.stderr) {
        console.error(`${GRAY}  stderr: ${delegateResult.stderr.slice(0, 250)}${RESET}`);
      }
      console.error(`${GRAY}  대안: --delegate 없이 실행해 기존 폴백 체인을 사용하세요.${RESET}`);
      console.error(`${GRAY}  예: tfx notion-read ${parsed.pageId} --comments${RESET}`);
      process.exit(1);
    }

    const delegateOutput = delegateResult.output.trim();
    const isDelegateFailureOutput =
      (delegateOutput.includes('조회 실패') || delegateOutput.includes('읽기 실패') || delegateOutput.includes('not_found')) &&
      delegateOutput.length < 500;

    if (delegateOutput.length <= 100 || isDelegateFailureOutput) {
      console.error(`${RED}✗${RESET} delegate 모드 실패: Claude 결과가 비정상적입니다.`);
      console.error(`${GRAY}  대안: --delegate 없이 실행해 Codex/Gemini/Claude 폴백 체인을 사용하세요.${RESET}`);
      process.exit(1);
    }

    const delegateTarget = outputFile || join('.notion-cache', `${parsed.pageId}.md`);
    const delegateDir = dirname(delegateTarget);
    if (delegateDir && delegateDir !== '.' && !existsSync(delegateDir)) {
      mkdirSync(delegateDir, { recursive: true });
    }
    writeFileSync(delegateTarget, delegateOutput, 'utf8');

    const savedPath = resolve(delegateTarget);
    console.error(`${GREEN}✓${RESET} delegate 결과 저장: ${savedPath}`);
    console.error(`${GRAY}  후속 작업 참조 경로: ${savedPath}${RESET}`);
    return;
  }

  // MCP 가용성 확인
  const mcpAvail = getNotionMcpClis(useGuest);
  console.error(
    `${GRAY}  MCP: codex=${mcpAvail.codex ? "O" : "X"} gemini=${mcpAvail.gemini ? "O" : "X"}${RESET}`,
  );

  // MCP 미설치 안내
  if (!mcpAvail.codex && !mcpAvail.gemini) {
    console.error(`${YELLOW}!${RESET} Codex/Gemini에 Notion MCP 미설치.`);
    console.error(`${GRAY}  Codex: codex mcp add notion${RESET}`);
    console.error(`${GRAY}  Gemini: ~/.gemini/settings.json에 notion 서버 추가${RESET}`);
    console.error(`${GRAY}  설치 후 tfx doctor --reset으로 캐시 갱신${RESET}`);
  } else if (!mcpAvail.codex) {
    console.error(`${GRAY}  Codex에 Notion MCP 미설치: codex mcp add notion${RESET}`);
  } else if (!mcpAvail.gemini) {
    console.error(`${GRAY}  Gemini에 Notion MCP 미설치: ~/.gemini/settings.json 확인${RESET}`);
  }

  // CLI 실행 순서 결정 (Codex → Gemini → Claude)
  let cliOrder;
  if (forceCli) {
    cliOrder = [forceCli];
  } else {
    cliOrder = [];
    if (mcpAvail.codex) cliOrder.push("codex");
    if (mcpAvail.gemini) cliOrder.push("gemini");
    // Claude는 항상 최종 폴백 (자체 Notion MCP — notion-guest 포함)
    cliOrder.push("claude");
  }

  // 실행 + 폴백
  let lastResult = null;
  let notionAccessFailed = false;

  for (const cli of cliOrder) {
    const currentPrompt = cli === "claude" ? claudePrompt : prompt;
    const result = runWithCli(cli, currentPrompt, timeout);
    lastResult = result;

    if (result.success) {
      // Codex JSON-line 출력 정리
      let output = cli === "codex" ? cleanCodexOutput(result.output) : result.output;
      output = output.trim();

      // 실패 마커 감지 (404, 접근 실패 등)
      const isFailureOutput =
        (output.includes("조회 실패") || output.includes("읽기 실패") || output.includes("not_found")) &&
        output.length < 500;

      if (output.length > 100 && !isFailureOutput) {
        console.error(`${GREEN}✓${RESET} ${cli}로 성공 (${output.length} chars, ${result.elapsed}s)`);

        if (outputFile) {
          const outDir = dirname(outputFile);
          if (outDir && outDir !== "." && !existsSync(outDir)) {
            mkdirSync(outDir, { recursive: true });
          }
          writeFileSync(outputFile, output, "utf8");
          console.error(`${GREEN}✓${RESET} 저장: ${outputFile}`);
        } else {
          console.log(output);
        }
        return;
      }

      // 404 접근 실패 감지
      if (isFailureOutput) {
        notionAccessFailed = true;
        console.error(`${YELLOW}!${RESET} ${cli}: Notion 접근 실패 (404) — 폴백`);
        if (!useGuest && cli !== "claude") {
          console.error(`${GRAY}  --guest 플래그로 notion-guest 통합 시도 가능${RESET}`);
        }
      } else {
        console.error(`${YELLOW}!${RESET} ${cli}: 출력 부족 (${output.length} chars) — 폴백`);
      }
    } else {
      console.error(`${YELLOW}!${RESET} ${cli} 실패: ${result.error}`);
      if (result.stderr) {
        console.error(`${GRAY}  stderr: ${result.stderr.slice(0, 200)}${RESET}`);
      }
    }

    // 다음 CLI로 폴백
    const idx = cliOrder.indexOf(cli);
    if (idx < cliOrder.length - 1) {
      const next = cliOrder[idx + 1];
      console.error(`${AMBER}▸${RESET} ${next}로 폴백 시도...`);
    }
  }

  // 전체 실패
  console.error(`${RED}✗${RESET} 모든 CLI 실패`);
  if (notionAccessFailed) {
    console.error(`${YELLOW}!${RESET} Notion 페이지 접근 권한 문제.`);
    console.error(`${GRAY}  1. Notion에서 페이지 → ... → 연결(Connections)에서 통합 추가${RESET}`);
    console.error(`${GRAY}  2. --guest 플래그로 notion-guest 통합 시도${RESET}`);
    console.error(`${GRAY}  3. --cli claude로 Claude 직접 사용 (Claude에 접근 권한 있는 경우)${RESET}`);
  }

  // 부분 결과라도 출력
  if (lastResult?.output) {
    const partial = lastResult.output.trim();
    if (partial.length > 10) {
      const cleaned = lastResult.cli === "codex" ? cleanCodexOutput(partial) : partial;
      if (outputFile) {
        writeFileSync(outputFile, cleaned, "utf8");
        console.error(`${YELLOW}!${RESET} 부분 결과 저장: ${outputFile}`);
      } else {
        console.log(cleaned);
      }
    }
  }

  process.exit(1);
}

main();
