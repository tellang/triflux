#!/usr/bin/env node
// hooks/hook-manager.mjs — 훅 우선순위 매니저
//
// 사용법:
//   node hook-manager.mjs scan            — 현재 settings.json 훅 스캔 → JSON 리포트
//   node hook-manager.mjs diff            — 오케스트레이터 적용 시 변경점 미리보기
//   node hook-manager.mjs apply           — settings.json에 오케스트레이터 적용
//   node hook-manager.mjs restore         — 백업에서 원래 settings.json 훅 복원
//   node hook-manager.mjs set-priority <hookId> <priority>  — 특정 훅 우선순위 변경
//   node hook-manager.mjs toggle <hookId>                   — 특정 훅 활성/비활성 토글
//   node hook-manager.mjs status          — 오케스트레이터 적용 상태 확인
//
// Claude 대화에서 AskUserQuestion으로 UI를 제공하며 내부적으로 이 명령들을 호출합니다.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_ROOT } from "./lib/resolve-root.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || process.env.USERPROFILE || "";
const SETTINGS_PATH = join(HOME, ".claude", "settings.json");
const BACKUP_PATH = join(HOME, ".claude", "settings.hooks-backup.json");
const REGISTRY_PATH = join(__dirname, "hook-registry.json");

// ── 유틸리티 ────────────────────────────────────────────────

function loadJSON(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function saveJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function getNodeExe() {
  return process.execPath || "node";
}

// ── scan: 현재 settings.json 훅 분석 ───────────────────────

function scan() {
  const settings = loadJSON(SETTINGS_PATH);
  if (!settings?.hooks) {
    return { status: "no_hooks", message: "settings.json에 훅이 없습니다.", events: {} };
  }

  const registry = loadJSON(REGISTRY_PATH);
  const report = { status: "ok", events: {}, unregistered: [] };

  for (const [event, matchers] of Object.entries(settings.hooks)) {
    report.events[event] = { hooks: [], count: 0 };

    for (const matcher of matchers) {
      for (const hook of matcher.hooks || []) {
        const cmd = hook.command || "";
        const hookInfo = {
          event,
          matcher: matcher.matcher || "*",
          command: cmd,
          timeout: hook.timeout,
          type: hook.type || "command",
          source: identifySource(cmd),
          registryMatch: null,
        };

        // 레지스트리에서 매칭 찾기
        if (registry?.events?.[event]) {
          const match = registry.events[event].find(
            (r) => normalizeCmd(resolveVars(r.command)) === normalizeCmd(cmd)
          );
          if (match) {
            hookInfo.registryMatch = { id: match.id, priority: match.priority };
          } else {
            report.unregistered.push(hookInfo);
          }
        }

        report.events[event].hooks.push(hookInfo);
        report.events[event].count++;
      }
    }
  }

  return report;
}

function identifySource(cmd) {
  if (/triflux/i.test(cmd) || /\$\{?CLAUDE_PLUGIN_ROOT\}?/i.test(cmd)) return "triflux";
  if (/oh-my-claudecode|omc/i.test(cmd)) return "omc";
  if (/session-vault/i.test(cmd)) return "session-vault";
  if (/compact-helper/i.test(cmd)) return "compact-helper";
  if (/headless-guard|tfx-gate/i.test(cmd)) return "omc";
  if (/mcp-cleanup/i.test(cmd)) return "system";
  return "unknown";
}

function normalizeCmd(cmd) {
  return cmd.replace(/["']/g, "").replace(/\\/g, "/").replace(/\s+/g, " ").trim().toLowerCase();
}

function resolveVars(cmd) {
  return cmd
    .replace(/\$\{PLUGIN_ROOT\}/g, PLUGIN_ROOT)
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, PLUGIN_ROOT)
    .replace(/\$\{HOME\}/g, HOME)
    .replace(/\$HOME\b/g, HOME);
}

// ── diff: 적용 시 변경점 미리보기 ───────────────────────────

function diff() {
  const settings = loadJSON(SETTINGS_PATH);
  if (!settings?.hooks) return { status: "no_hooks", changes: [] };

  const registry = loadJSON(REGISTRY_PATH);
  if (!registry) return { status: "no_registry", changes: [] };

  const changes = [];
  const currentEvents = Object.keys(settings.hooks);
  const registryEvents = Object.keys(registry.events);
  const allEvents = [...new Set([...currentEvents, ...registryEvents])];

  for (const event of allEvents) {
    const currentHooks = settings.hooks[event] || [];
    const registryHooks = registry.events[event] || [];

    const currentCount = currentHooks.reduce((n, m) => n + (m.hooks?.length || 0), 0);
    const registryCount = registryHooks.filter((h) => h.enabled !== false).length;

    if (currentCount === 1 && isOrchestrator(currentHooks)) {
      changes.push({ event, action: "already_orchestrated", currentCount, registryCount });
    } else if (currentCount > 0 || registryCount > 0) {
      changes.push({
        event,
        action: "will_replace",
        currentCount,
        registryCount,
        detail: `${currentCount}개 개별 훅 → 1개 오케스트레이터 (내부 ${registryCount}개 순차 실행)`,
      });
    }
  }

  return { status: "ok", changes };
}

function isOrchestrator(matchers) {
  if (!matchers || matchers.length !== 1) return false;
  const hooks = matchers[0]?.hooks || [];
  return hooks.length === 1 && (hooks[0]?.command || "").includes("hook-orchestrator");
}

// ── apply: 오케스트레이터 적용 ──────────────────────────────

function apply() {
  const settings = loadJSON(SETTINGS_PATH);
  if (!settings) return { status: "error", message: "settings.json을 찾을 수 없습니다." };

  const registry = loadJSON(REGISTRY_PATH);
  if (!registry) return { status: "error", message: "hook-registry.json을 찾을 수 없습니다." };

  // 백업
  if (settings.hooks && !existsSync(BACKUP_PATH)) {
    saveJSON(BACKUP_PATH, { hooks: settings.hooks, backedUpAt: new Date().toISOString() });
  }

  // 오케스트레이터 명령 생성
  const nodeExe = getNodeExe();
  const orchestratorPath = "${CLAUDE_PLUGIN_ROOT}/hooks/hook-orchestrator.mjs";
  const orchestratorCmd = `"${nodeExe}" "${orchestratorPath}"`;

  // 모든 이벤트를 하나의 오케스트레이터로 통합
  const newHooks = {};
  const registryEvents = Object.keys(registry.events);

  // 레지스트리에 없는 기존 이벤트도 보존
  const allEvents = [
    ...new Set([...registryEvents, ...Object.keys(settings.hooks || {})]),
  ];

  for (const event of allEvents) {
    const registryEntries = registry.events[event] || [];
    const enabledEntries = registryEntries.filter((h) => h.enabled !== false);

    if (enabledEntries.length > 0) {
      // 레지스트리에 있으면 → 오케스트레이터로 교체
      // 가장 큰 timeout을 기준으로 오케스트레이터 timeout 설정
      const maxTimeout = Math.max(...enabledEntries.map((h) => h.timeout || 10)) + 5;

      newHooks[event] = [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: orchestratorCmd,
              timeout: maxTimeout,
            },
          ],
        },
      ];
    } else {
      // 레지스트리에 없으면 기존 유지
      if (settings.hooks?.[event]) {
        newHooks[event] = settings.hooks[event];
      }
    }
  }

  settings.hooks = newHooks;
  saveJSON(SETTINGS_PATH, settings);

  return {
    status: "applied",
    message: `오케스트레이터 적용 완료. ${registryEvents.length}개 이벤트가 순차 실행으로 전환됩니다.`,
    events: registryEvents,
    backupPath: BACKUP_PATH,
  };
}

// ── restore: 백업에서 복원 ──────────────────────────────────

function restore() {
  if (!existsSync(BACKUP_PATH)) {
    return { status: "no_backup", message: "백업 파일이 없습니다. apply 전에는 복원할 수 없습니다." };
  }

  const backup = loadJSON(BACKUP_PATH);
  if (!backup?.hooks) {
    return { status: "error", message: "백업 파일이 손상되었습니다." };
  }

  const settings = loadJSON(SETTINGS_PATH);
  if (!settings) return { status: "error", message: "settings.json을 찾을 수 없습니다." };

  settings.hooks = backup.hooks;
  saveJSON(SETTINGS_PATH, settings);

  return {
    status: "restored",
    message: `원래 훅 설정이 복원되었습니다. (백업 시점: ${backup.backedUpAt})`,
  };
}

// ── set-priority: 우선순위 변경 ─────────────────────────────

function setPriority(hookId, priority) {
  const registry = loadJSON(REGISTRY_PATH);
  if (!registry) return { status: "error", message: "레지스트리를 찾을 수 없습니다." };

  const numPriority = parseInt(priority, 10);
  if (isNaN(numPriority)) return { status: "error", message: "priority는 숫자여야 합니다." };

  let found = false;
  for (const hooks of Object.values(registry.events)) {
    const hook = hooks.find((h) => h.id === hookId);
    if (hook) {
      hook.priority = numPriority;
      found = true;
      break;
    }
  }

  if (!found) return { status: "not_found", message: `훅 '${hookId}'를 찾을 수 없습니다.` };

  saveJSON(REGISTRY_PATH, registry);
  return { status: "ok", message: `${hookId}의 우선순위가 ${numPriority}로 변경되었습니다.` };
}

// ── toggle: 활성/비활성 토글 ────────────────────────────────

function toggle(hookId) {
  const registry = loadJSON(REGISTRY_PATH);
  if (!registry) return { status: "error", message: "레지스트리를 찾을 수 없습니다." };

  let found = false;
  let newState = false;
  for (const hooks of Object.values(registry.events)) {
    const hook = hooks.find((h) => h.id === hookId);
    if (hook) {
      hook.enabled = !(hook.enabled !== false);
      newState = hook.enabled;
      found = true;
      break;
    }
  }

  if (!found) return { status: "not_found", message: `훅 '${hookId}'를 찾을 수 없습니다.` };

  saveJSON(REGISTRY_PATH, registry);
  return { status: "ok", message: `${hookId}: ${newState ? "활성화" : "비활성화"}` };
}

// ── status: 현재 적용 상태 ──────────────────────────────────

function status() {
  const settings = loadJSON(SETTINGS_PATH);
  if (!settings?.hooks) return { orchestrated: false, message: "훅 없음" };

  let orchestrated = 0;
  let individual = 0;

  for (const [event, matchers] of Object.entries(settings.hooks)) {
    if (isOrchestrator(matchers)) {
      orchestrated++;
    } else {
      individual++;
    }
  }

  const hasBackup = existsSync(BACKUP_PATH);

  return {
    orchestrated: orchestrated > 0,
    orchestratedEvents: orchestrated,
    individualEvents: individual,
    hasBackup,
    message: orchestrated > 0
      ? `오케스트레이터 적용 중: ${orchestrated}개 이벤트 통합, ${individual}개 개별 유지`
      : `오케스트레이터 미적용. ${individual}개 이벤트가 개별 훅으로 실행 중`,
  };
}

// ── CLI 진입점 ──────────────────────────────────────────────

const [, , command, ...args] = process.argv;

const commands = {
  scan: () => scan(),
  diff: () => diff(),
  apply: () => apply(),
  restore: () => restore(),
  "set-priority": () => setPriority(args[0], args[1]),
  toggle: () => toggle(args[0]),
  status: () => status(),
};

if (!command || !commands[command]) {
  console.log(JSON.stringify({
    error: "사용법: node hook-manager.mjs <scan|diff|apply|restore|set-priority|toggle|status>",
    commands: Object.keys(commands),
  }));
  process.exit(1);
}

const result = commands[command]();
console.log(JSON.stringify(result, null, 2));
