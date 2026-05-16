#!/usr/bin/env node
// scripts/lib/dynamic-route-cli.mjs
//
// Phase 1 Wire-up 3 helper — tfx-route.sh 등 sh 경로에서 dynamic routing
// decision 을 받아 단일 CLI 문자열 (또는 JSON) 으로 출력한다.
//
// 사용:
//   node scripts/lib/dynamic-route-cli.mjs --agent-hint codex
//   → "codex"
//   node scripts/lib/dynamic-route-cli.mjs --agent-hint codex --json
//   → {"scenario":"fallback","mode":"codex-default","shards":[{"cli":"codex",...}]}
//   node scripts/lib/dynamic-route-cli.mjs --agent-hint codex --field scenario
//   → "fallback"
//
// 정책:
//   - opt-in env TRIFLUX_DYNAMIC_ROUTING=1|true 미설정 시 즉시 silent exit 0
//     (override 없음 = stdout empty, sh caller 가 graceful no-op).
//   - error 발생 시 stderr 에 한 줄 + exit 0 (sh caller 가 fallback path 진행).

import { createDynamicRouter } from "../../hub/dynamic-routing-engine.mjs";

function parseArgs(argv) {
  const args = {
    taskId: `tfx-route-${process.pid}-${Date.now()}`,
    agentHint: "codex",
    teamSize: 1,
    json: false,
    field: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    switch (v) {
      case "--task-id":
        args.taskId = argv[++i] || args.taskId;
        break;
      case "--agent-hint":
        args.agentHint = argv[++i] || args.agentHint;
        break;
      case "--team-size":
        args.teamSize = Number(argv[++i]) || args.teamSize;
        break;
      case "--json":
        args.json = true;
        break;
      case "--field":
        args.field = argv[++i] || null;
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          "Usage: dynamic-route-cli.mjs [--task-id ID] [--agent-hint CLI] [--team-size N] [--json|--field FIELD]\n",
        );
        process.exit(0);
        break;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  // opt-in env 미설정 시 silent no-op (sh caller graceful path)
  const flag = process.env.TRIFLUX_DYNAMIC_ROUTING;
  if (flag !== "1" && flag !== "true") return;

  let decision;
  try {
    const router = createDynamicRouter();
    decision = await router.routeRequest({
      task_id: args.taskId,
      team_size: args.teamSize,
      agent_hint: args.agentHint,
    });
  } catch (err) {
    process.stderr.write(
      `[dynamic-route-cli] error: ${err?.message || String(err)}\n`,
    );
    return;
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(decision));
    return;
  }

  if (args.field) {
    const value = decision?.[args.field];
    if (value !== undefined && value !== null) {
      process.stdout.write(String(value));
    }
    return;
  }

  // 기본 — shards[0].cli 만 stdout 으로 (sh caller 가 즉시 비교)
  const cli = decision?.shards?.[0]?.cli;
  if (cli) {
    process.stdout.write(String(cli));
  }
}

main().catch((err) => {
  process.stderr.write(
    `[dynamic-route-cli] fatal: ${err?.message || String(err)}\n`,
  );
  process.exit(0); // sh caller 가 정상 fallback 하도록 always 0
});
