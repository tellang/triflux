// hub/team/lead-launch.mjs: `tfx lead <역할>` 로 리드 세션을 띄운다.
// 리드는 사람이 직접 쓰는 세션이라 CLI 별 실행 명령을 사용자가 정한다(기본은 CLI 이름).
// 워커는 tfx-live 가 기본 명령으로 띄우므로 이 설정과 무관하다.

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  modelFamilyPaths,
  resolveModelFamilies,
} from "../../scripts/lib/model-family-resolver.mjs";
import {
  isJevEnabled,
  judgeTaskRouting,
  recordJevStat,
} from "@triflux/core/hub/lib/jev-addon.mjs";

const execFileAsync = promisify(execFile);
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TFX_LIVE = join(PKG_ROOT, "bin", "tfx-live.mjs");
const LEAD_SKILL = join(PKG_ROOT, "skills", "tfx-lead", "SKILL.md");
export const LEAD_CLIS = ["claude", "codex", "agy"];

export function leadConfigPath() {
  return join(modelFamilyPaths().stateDir, "lead.json");
}

/** lead.json 을 읽는다. 없으면 null. 10.85.0 의 `launcher` 한 칸은 Claude 실행 명령으로 읽는다. */
export function readLeadConfig(path = leadConfigPath()) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const config = JSON.parse(text);
  const isObject = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (
    !isObject(config) ||
    (config.launchers !== undefined && !isObject(config.launchers))
  )
    throw new Error(`${path} 는 {"launchers": {...}} 형식이어야 한다`);
  const launchers = { ...config.launchers };
  if (config.launcher !== undefined && launchers.claude === undefined)
    launchers.claude = config.launcher;
  for (const [cli, launcher] of Object.entries(launchers)) {
    if (
      typeof launcher !== "string" ||
      !launcher.trim() ||
      /[\r\n]/u.test(launcher)
    )
      throw new Error(`${path} 의 launchers.${cli} 는 한 줄 문자열이어야 한다`);
    launchers[cli] = launcher.trim();
  }
  return { launchers };
}

export function writeLeadConfig(launchers, path = leadConfigPath()) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ launchers }, null, 2)}\n`);
}

const CLI_LABELS = {
  claude: "Claude",
  codex: "Codex",
  agy: "Antigravity(agy)",
};

/**
 * setup 과 update 때 아직 정하지 않은 CLI 의 리드 실행 명령을 한 번 묻는다.
 * 설치되지 않은 CLI 는 묻지 않고, 물을 수 없으면(비대화형) 다음 대화형 실행으로 미룬다.
 */
export async function offerLeadLaunchers({
  interactive,
  askText,
  hasCommand,
  notice = () => {},
  configPath = leadConfigPath(),
}) {
  const launchers = { ...readLeadConfig(configPath)?.launchers };
  const missing = LEAD_CLIS.filter(
    (cli) => launchers[cli] === undefined && hasCommand(cli),
  );
  if (missing.length === 0) return "present";
  if (!interactive) return "deferred";
  notice(
    "tfx lead 로 리드 세션을 띄울 때 쓸 실행 명령을 정한다. 래퍼, 별칭, 셸 함수로 켜면 그 명령을 적고, 그대로 쓰면 Enter. 워커에는 쓰지 않는다.",
  );
  for (const cli of missing) {
    const answer = await askText(
      `${CLI_LABELS[cli]} 를 켤 때 쓰는 명령 [${cli}]`,
    );
    launchers[cli] = answer.trim().split(/\r?\n/u)[0] || cli;
  }
  writeLeadConfig(launchers, configPath);
  return "saved";
}

/** 실행 명령은 --launcher, lead.json 의 launchers.<cli>, CLI 이름 순으로 고른다. */
export function resolveLauncher({ cli = "claude", flag, configPath } = {}) {
  if (flag) return flag;
  return readLeadConfig(configPath)?.launchers[cli] ?? cli;
}

/** tmux 대상 문법과 겹치는 문자(. :)와 공백만 바꿔 `<폴더>-lead` 로 만든다. */
export function leadSessionName(cwd) {
  return `${basename(resolve(cwd)).replace(/[.:\s]/gu, "-")}-lead`;
}

/** /tfx-lead 와 같은 규칙으로 이름을 정한다. 날짜로 시작하면 그대로 쓴다. */
export function leadDisplayName(role, now = new Date()) {
  if (/^\d{1,2}\.\d{1,2} \S/u.test(role)) return role;
  return `${now.getMonth() + 1}.${now.getDate()} ${role}`;
}

/** Claude 는 mod 가 /tfx-lead 를 처리한다. Codex 와 agy 는 mod 가 없어 스킬 파일을 읽게 한다. */
export function leadEntryPrompt(cli, role) {
  if (cli === "claude") return `/tfx-lead ${role}`;
  return `${LEAD_SKILL} 를 읽고 이 세션이 ${role} 리드를 맡는다. 처음 활성화할 때 "보유 자산과 선택" 절로 tfx-harness, tfx-auto, tfx-live 등 설치 자산을 인지하고 요청에 맞는 경로를 선택한다. 그 스킬의 절차를 따른다.`;
}

async function runLive(args, run) {
  let stdout;
  try {
    ({ stdout } = await run(process.execPath, [TFX_LIVE, ...args], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    }));
  } catch (error) {
    // tfx-live 는 실패해도 원인을 담은 JSON 을 stdout 에 쓰고 exit 1 로 끝난다.
    if (!error.stdout) throw error;
    stdout = error.stdout;
  }
  return JSON.parse(stdout);
}

export async function launchLead(
  {
    cli = "claude",
    role,
    cwd = process.cwd(),
    session,
    model,
    effort,
    launcher = cli,
    task,
  },
  {
    run = execFileAsync,
    jevOptions = {},
    modelOptions = {},
    judgeRouting = judgeTaskRouting,
  } = {},
) {
  if (!LEAD_CLIS.includes(cli))
    throw new Error(`--cli 는 ${LEAD_CLIS.join(", ")} 중 하나여야 한다`);
  if (!role?.trim()) throw new Error("역할이 필요하다: tfx lead <역할>");
  const routing = {
    enabled: isJevEnabled(jevOptions),
    attempted: false,
    complexity: null,
    recommendedProfile: null,
    recommendedModel: null,
    recommendedEffort: null,
    effectiveModel: model ?? null,
    effectiveEffort: effort ?? null,
    confidence: null,
    source: "default",
    reason: "jev_disabled",
    appliedTo: null,
  };
  if (routing.enabled) {
    routing.attempted = true;
    routing.reason = "no_accepted_recommendation";
    try {
      const recommendation = await judgeRouting(
        {
          prompt: [
            `Role: ${role.trim().slice(0, 200)}. This lead continuously coordinates multiple workers and evaluates their results.`,
            task?.trim() ? `Task: ${task.trim().slice(0, 1000)}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          agentType: "lead",
          cliType: cli,
        },
        jevOptions,
      );
      routing.complexity = recommendation?.complexity ?? null;
      routing.confidence = recommendation?.confidence ?? null;
      if (recommendation?.complexity) {
        routing.recommendedProfile =
          cli === "codex"
            ? recommendation.codexProfile
            : cli === "agy"
              ? recommendation.agyProfile
              : recommendation.claudeModel;
        const selected =
          cli === "claude"
            ? {
                model: recommendation.claudeModel,
                effort: recommendation.claudeEffort,
              }
            : resolveModelFamilies(cli, {
                ...modelOptions,
                allowCommand: false,
                persist: false,
              }).profiles[routing.recommendedProfile];
        if (selected?.model && selected?.effort) {
          routing.recommendedModel = selected.model;
          routing.recommendedEffort = selected.effort;
          model = selected.model;
          effort = selected.effort;
          routing.source = "jev";
          routing.reason = "jev_applied";
          routing.appliedTo = "start_args";
        } else routing.reason = "unsupported_profile";
      }
    } catch {
      routing.reason = "jev_or_resolver_failed";
    }
  }
  // 한쪽만 명시해도 쌍을 보존한다. 임의의 래퍼와 셸 명령은 안전하게 해석할 수 없다.
  if (
    routing.effectiveModel !== null ||
    routing.effectiveEffort !== null ||
    launcher !== cli
  ) {
    model = routing.effectiveModel ?? undefined;
    effort = routing.effectiveEffort ?? undefined;
    routing.source = "explicit";
    routing.reason =
      routing.effectiveModel !== null || routing.effectiveEffort !== null
        ? "explicit_model_effort_preserved"
        : "launcher_preserved";
    routing.appliedTo = null;
  }
  routing.effectiveModel = model ?? null;
  routing.effectiveEffort = effort ?? null;
  const target = session || leadSessionName(cwd);
  const name = leadDisplayName(role.trim());
  const summary = { cli, session: target, name, launcher, routing };
  let start;
  let startReturned = false;
  try {
    start = await runLive(
      [
        "start",
        "--cli",
        cli,
        "--session",
        target,
        "--name",
        name,
        "--launcher",
        launcher,
        "--cwd",
        resolve(cwd),
        ...(model ? ["--model", model] : []),
        ...(effort ? ["--effort", effort] : []),
      ],
      run,
    );
    startReturned = true;
  } finally {
    if (routing.enabled) {
      recordJevStat(
        {
          hook: "lead_model_selection",
          kind: "model_selection",
          source: routing.source,
          reason: startReturned ? routing.reason : "start_failed",
          selectionReason: routing.reason,
          recommendedProfile: routing.recommendedProfile,
          recommendedModel: routing.recommendedModel,
          recommendedEffort: routing.recommendedEffort,
          effectiveModel: routing.effectiveModel,
          effectiveEffort: routing.effectiveEffort,
          confidence: routing.confidence,
          appliedTo: startReturned ? routing.appliedTo : null,
          intervened: startReturned && routing.appliedTo === "start_args",
          startReady: Boolean(start?.ready),
          startStatus: startReturned ? "returned" : "threw",
        },
        jevOptions,
      );
    }
  }
  if (!start.ready) return { ok: false, ...summary, start };
  // Claude 슬래시 명령은 tmux 입력으로만 실행되고, Claude 안에서 호출해도 SendMessage 로 바뀌지 않게 한다.
  const ask = await runLive(
    [
      "ask",
      "--cli",
      cli,
      "--session",
      target,
      "--prompt",
      leadEntryPrompt(cli, role.trim()),
      "--no-wait",
      ...(cli === "claude" ? ["--via-tmux"] : []),
    ],
    run,
  );
  return { ok: Boolean(ask.ok), ...summary, start, ask };
}
