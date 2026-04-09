#!/usr/bin/env node
// tui/doctor.mjs — Interactive triflux doctor TUI
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOLD,
  box,
  clear,
  confirm,
  DIM,
  divider,
  fail,
  GRAY,
  GREEN,
  info,
  label,
  ok,
  onExit,
  RED,
  RESET,
  select,
  showCursor,
  spinner,
  table,
  warn,
  YELLOW,
} from "./core.mjs";

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLAUDE_DIR = join(homedir(), ".claude");
const CACHE_DIR = join(CLAUDE_DIR, "cache");

const CACHE_FILES = [
  { name: "claude-usage-cache.json", desc: "Claude 사용량" },
  { name: ".claude-refresh-lock", desc: "리프레시 락" },
  { name: "codex-rate-limits-cache.json", desc: "Codex 레이트 리밋" },
  { name: "gemini-quota-cache.json", desc: "Gemini 쿼터" },
  { name: "gemini-project-id.json", desc: "Gemini 프로젝트 ID" },
  { name: "gemini-session-cache.json", desc: "Gemini 세션" },
  { name: "gemini-rpm-tracker.json", desc: "Gemini RPM" },
  { name: "sv-accumulator.json", desc: "절약량 누적" },
  { name: "mcp-inventory.json", desc: "MCP 인벤토리" },
  { name: "cli-issues.jsonl", desc: "CLI 이슈 로그" },
  { name: "triflux-update-check.json", desc: "업데이트 체크" },
  { name: "tfx-preflight.json", desc: "Preflight 캐시 (CLI/Hub 가용성)" },
];

// ── Run triflux doctor --json ──

function runDoctor(mode = "check") {
  const args = [join(PKG_ROOT, "bin", "triflux.mjs"), "doctor", "--json"];
  if (mode === "fix") args.push("--fix");

  try {
    const out = execFileSync(process.execPath, args, {
      timeout: 30000,
      encoding: "utf8",
      windowsHide: true,
    });
    // Extract JSON from output (may have ANSI/text before it)
    const jsonMatch = out.match(/\{[\s\S]*\}$/m);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {
    if (e.stdout) {
      const jsonMatch = e.stdout.match(/\{[\s\S]*\}$/m);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    }
  }
  return null;
}

// ── Display Results ──

function statusIcon(status) {
  const map = {
    ok: `${GREEN}✓${RESET}`,
    missing: `${RED}✗${RESET}`,
    partial: `${YELLOW}⚠${RESET}`,
    warning: `${YELLOW}⚠${RESET}`,
    optional_missing: `${GRAY}○${RESET}`,
  };
  return map[status] || `${GRAY}?${RESET}`;
}

function showReport(report) {
  if (!report) {
    fail("진단 결과를 가져올 수 없습니다.");
    return;
  }

  console.log();
  const statusColor =
    report.issue_count === 0 ? GREEN : report.issue_count <= 2 ? YELLOW : RED;
  label(
    "상태",
    `${statusColor}${report.issue_count === 0 ? "정상" : `${report.issue_count}개 이슈`}${RESET}`,
  );
  label("모드", report.mode);
  console.log();

  const headers = ["항목", "상태", "비고"];
  const rows = (report.checks || []).map((c) => {
    let note = "";
    if (c.version) note = `v${c.version}`;
    if (c.missing_profiles?.length)
      note = `누락: ${c.missing_profiles.join(", ")}`;
    if (c.fix) note += note ? ` → ${c.fix}` : c.fix;
    if (c.path && !c.fix) note = c.path;

    const icon =
      c.status === "ok"
        ? statusIcon("ok")
        : c.optional
          ? statusIcon("optional_missing")
          : statusIcon(c.status);

    return [
      `${icon} ${c.name}`,
      c.status === "ok" ? `${GREEN}정상${RESET}` : `${RED}${c.status}${RESET}`,
      note ? `${DIM}${note}${RESET}` : "",
    ];
  });

  if (rows.length > 0) table(headers, rows);

  // Actions (from fix/reset mode)
  if (report.actions?.length > 0) {
    console.log();
    info(`수행된 작업: ${report.actions.length}개`);
    for (const action of report.actions) {
      const icon =
        action.status === "ok" ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
      console.log(
        `    ${icon} ${action.type}: ${action.name || action.path || ""}`,
      );
    }
  }
}

// ── Cache Management ──

function getCacheStatus() {
  const results = [];
  for (const { name, desc } of CACHE_FILES) {
    const fp = join(CACHE_DIR, name);
    if (existsSync(fp)) {
      let size = 0;
      try {
        size = readFileSync(fp).length;
      } catch {}
      let hasError = false;
      try {
        const parsed = JSON.parse(readFileSync(fp, "utf8"));
        hasError = !!parsed.error;
      } catch {
        hasError = true;
      }
      results.push({ name, desc, exists: true, size, hasError });
    } else {
      results.push({ name, desc, exists: false, size: 0, hasError: false });
    }
  }
  return results;
}

function showCacheStatus() {
  const caches = getCacheStatus();
  const existing = caches.filter((c) => c.exists);

  if (existing.length === 0) {
    info("캐시 파일 없음 (깨끗한 상태)");
    return;
  }

  console.log();
  const headers = ["캐시", "크기", "상태"];
  const rows = existing.map((c) => [
    c.desc,
    c.size < 1024 ? `${c.size}B` : `${(c.size / 1024).toFixed(1)}KB`,
    c.hasError ? `${RED}에러${RESET}` : `${GREEN}정상${RESET}`,
  ]);
  table(headers, rows);
}

async function selectiveReset() {
  const caches = getCacheStatus().filter((c) => c.exists);
  if (caches.length === 0) {
    info("삭제할 캐시 파일이 없습니다.");
    return;
  }

  const options = [
    { label: "전체 삭제", hint: `${caches.length}개 파일` },
    { label: "에러 캐시만 삭제", hint: "손상된 파일만" },
    { label: "선택 삭제", hint: "하나씩 선택" },
    { label: "취소", hint: "" },
  ];

  const choice = await select("삭제 방식", options);
  if (!choice || choice.index === 3) return;

  let targets = [];
  if (choice.index === 0) {
    targets = caches;
  } else if (choice.index === 1) {
    targets = caches.filter((c) => c.hasError);
    if (targets.length === 0) {
      info("에러 상태의 캐시가 없습니다.");
      return;
    }
  } else {
    for (const c of caches) {
      const del = await confirm(`${c.desc} (${c.name}) 삭제?`, c.hasError);
      if (del) targets.push(c);
    }
  }

  if (targets.length === 0) return;

  if (!(await confirm(`${targets.length}개 캐시 파일을 삭제하시겠습니까?`)))
    return;

  let deleted = 0;
  for (const c of targets) {
    try {
      unlinkSync(join(CACHE_DIR, c.name));
      ok(`삭제: ${c.desc}`);
      deleted++;
    } catch (e) {
      fail(`삭제 실패: ${c.desc} — ${e.message}`);
    }
  }

  ok(`${BOLD}${deleted}개${RESET} 캐시 파일 삭제 완료`);
}

// ── Orphan Teams ──

async function checkOrphanTeams() {
  const teamsDir = join(CLAUDE_DIR, "teams");
  if (!existsSync(teamsDir)) {
    info("teams 디렉토리 없음");
    return;
  }

  const entries = readdirSync(teamsDir).filter((e) => !e.startsWith("."));
  if (entries.length === 0) {
    ok("잔존 팀 없음");
    return;
  }

  warn(`${entries.length}개 팀 세션 발견`);
  for (const e of entries) {
    console.log(`    ${DIM}${e}${RESET}`);
  }

  if (await confirm("잔존 팀 정리를 시도하시겠습니까?", false)) {
    const spin = spinner("팀 정리 중...");
    try {
      // Delegate to triflux's cleanup
      execFileSync(
        process.execPath,
        [join(PKG_ROOT, "bin", "triflux.mjs"), "doctor", "--fix"],
        {
          timeout: 30000,
          stdio: "ignore",
          windowsHide: true,
        },
      );
      spin.stop();
      ok("팀 정리 완료");
    } catch {
      spin.stop();
      warn("팀 정리 실패 — 수동 삭제가 필요할 수 있습니다");
    }
  }
}

// ── Main Menu ──

const MENU = [
  { label: "진단 (Diagnose)", hint: "읽기 전용 검사" },
  { label: "수정 (Fix)", hint: "자동 수정 + 진단" },
  { label: "캐시 관리 (Cache)", hint: "캐시 조회/선택 삭제" },
  { label: "팀 세션 정리 (Teams)", hint: "잔존 팀 감지/정리" },
  { label: "전체 초기화 (Reset)", hint: "캐시 전체 삭제 + 재생성" },
  { label: "종료", hint: "Ctrl+C" },
];

async function main() {
  onExit(() => {});
  clear();

  while (true) {
    box("triflux Doctor", 46);
    console.log();

    const choice = await select("작업 선택", MENU);
    if (!choice || choice.index === 5) {
      console.log();
      info("종료합니다.");
      showCursor();
      break;
    }

    console.log();

    switch (choice.index) {
      case 0: {
        const spin = spinner("진단 중...");
        const report = runDoctor("check");
        spin.stop();
        showReport(report);
        break;
      }

      case 1: {
        if (!(await confirm("자동 수정을 실행하시겠습니까?"))) break;
        const spin = spinner("수정 + 진단 중...");
        const report = runDoctor("fix");
        spin.stop();
        showReport(report);
        break;
      }

      case 2: {
        showCacheStatus();
        console.log();
        await selectiveReset();
        break;
      }

      case 3: {
        await checkOrphanTeams();
        break;
      }

      case 4: {
        if (
          !(await confirm(
            `${RED}전체 캐시를 초기화${RESET}하시겠습니까?`,
            false,
          ))
        )
          break;
        const spin = spinner("초기화 + 재생성 중...");
        try {
          execFileSync(
            process.execPath,
            [join(PKG_ROOT, "bin", "triflux.mjs"), "doctor", "--reset"],
            { timeout: 60000, encoding: "utf8", windowsHide: true },
          );
          spin.stop();
          ok("전체 초기화 + 재생성 완료");
        } catch {
          spin.stop();
          warn("초기화 중 일부 실패 — triflux doctor --reset으로 재시도");
        }
        break;
      }
    }

    console.log();
    divider(46);
  }
}

main().catch((e) => {
  showCursor();
  console.error(e);
  process.exit(1);
});
