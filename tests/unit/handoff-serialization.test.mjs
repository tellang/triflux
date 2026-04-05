import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { buildHandoffPrompt, collectHandoffContext, serializeHandoff } from "../../scripts/lib/handoff.mjs";

const tempDirs = [];

function createTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createCommandRunner(map) {
  return (command) => {
    if (Object.hasOwn(map, command)) {
      return map[command];
    }
    throw new Error(`unexpected command: ${command}`);
  };
}

function makeGitRunner(overrides = {}) {
  const defaults = {
    "git rev-parse --show-toplevel": "/repo/triflux\n",
    "git rev-parse --abbrev-ref HEAD": "main\n",
    "git status --short": "",
    "git diff --stat --no-color": "",
    "git rev-list --left-right --count @{upstream}...HEAD": "",
  };
  return createCommandRunner({ ...defaults, ...overrides });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

// ── collectHandoffContext ──

describe("collectHandoffContext()", () => {
  it("git 컨텍스트와 결정사항을 직렬화한다", () => {
    const cwd = createTempDir("triflux-handoff-context-");
    const context = collectHandoffContext({
      cwd,
      target: "remote",
      generatedAt: "2026-04-04T10:00:00.000Z",
      decisions: ["API 경로 유지", "테스트 우선"],
      commandRunner: createCommandRunner({
        "git rev-parse --show-toplevel": "/repo/triflux\n",
        "git rev-parse --abbrev-ref HEAD": "feature/lake3\n",
        "git status --short": " M bin/triflux.mjs\n?? scripts/lib/handoff.mjs\nR  old.mjs -> new.mjs\n",
        "git diff --stat --no-color": " bin/triflux.mjs | 10 +++++-----\n 1 file changed, 5 insertions(+), 5 deletions(-)\n",
        "git rev-list --left-right --count @{upstream}...HEAD": "1 3\n",
      }),
    });

    assert.equal(context.repository, "triflux");
    assert.equal(context.branch, "feature/lake3");
    assert.deepEqual(context.upstream, { ahead: 3, behind: 1 });
    assert.deepEqual(context.changedFiles, ["bin/triflux.mjs", "scripts/lib/handoff.mjs", "new.mjs"]);
    assert.deepEqual(context.decisions, ["API 경로 유지", "테스트 우선"]);
  });

  it("git 정보가 없어도 안전하게 fallback 한다", () => {
    const cwd = createTempDir("triflux-handoff-fallback-");
    const context = collectHandoffContext({
      cwd,
      target: "local",
      generatedAt: "2026-04-04T10:00:00.000Z",
      commandRunner: () => {
        throw new Error("not a git repo");
      },
    });

    assert.equal(context.branch, null);
    assert.equal(context.gitRoot, null);
    assert.deepEqual(context.changedFiles, []);
    assert.deepEqual(context.decisions, []);
  });

  it("target 미지정 시 기본값 remote를 사용한다", () => {
    const cwd = createTempDir("triflux-handoff-default-target-");
    const context = collectHandoffContext({
      cwd,
      generatedAt: "2026-04-04T10:00:00.000Z",
      commandRunner: makeGitRunner(),
    });
    assert.equal(context.target, "remote");
  });

  it("target=local이면 local로 설정된다", () => {
    const cwd = createTempDir("triflux-handoff-local-target-");
    const context = collectHandoffContext({
      cwd,
      target: "local",
      generatedAt: "2026-04-04T10:00:00.000Z",
      commandRunner: makeGitRunner(),
    });
    assert.equal(context.target, "local");
  });

  it("gitRoot가 없으면 cwd의 basename을 repository로 사용한다", () => {
    const cwd = createTempDir("triflux-handoff-no-gitroot-");
    const context = collectHandoffContext({
      cwd,
      generatedAt: "2026-04-04T10:00:00.000Z",
      commandRunner: () => { throw new Error("no git"); },
    });
    assert.equal(context.repository, basename(resolve(cwd)));
  });

  it("decisions 배열과 decisionFile을 병합한다", () => {
    const cwd = createTempDir("triflux-handoff-merge-decisions-");
    const decisionFile = join(cwd, "decisions.md");
    writeFileSync(decisionFile, "- 파일에서 온 결정\n- 중복 항목\n", "utf8");

    const context = collectHandoffContext({
      cwd,
      decisions: ["인라인 결정", "중복 항목"],
      decisionFile,
      generatedAt: "2026-04-04T10:00:00.000Z",
      commandRunner: makeGitRunner(),
    });

    assert.ok(context.decisions.includes("인라인 결정"));
    assert.ok(context.decisions.includes("파일에서 온 결정"));
    assert.ok(context.decisions.includes("중복 항목"));
    // 중복 제거 확인
    const dupeCount = context.decisions.filter((d) => d === "중복 항목").length;
    assert.equal(dupeCount, 1);
  });

  it("존재하지 않는 decisionFile은 무시한다", () => {
    const cwd = createTempDir("triflux-handoff-missing-decision-");
    const context = collectHandoffContext({
      cwd,
      decisionFile: join(cwd, "nonexistent.md"),
      generatedAt: "2026-04-04T10:00:00.000Z",
      commandRunner: makeGitRunner(),
    });
    assert.deepEqual(context.decisions, []);
  });

  it("claudeMdPaths를 직접 주입할 수 있다", () => {
    const cwd = createTempDir("triflux-handoff-claudemd-inject-");
    const context = collectHandoffContext({
      cwd,
      claudeMdPaths: ["/custom/CLAUDE.md", "/other/CLAUDE.md"],
      generatedAt: "2026-04-04T10:00:00.000Z",
      commandRunner: makeGitRunner(),
    });
    assert.deepEqual(context.claudeMdPaths, ["/custom/CLAUDE.md", "/other/CLAUDE.md"]);
  });

  it("빈 git status는 빈 changedFiles/fileStatus를 반환한다", () => {
    const cwd = createTempDir("triflux-handoff-empty-status-");
    const context = collectHandoffContext({
      cwd,
      generatedAt: "2026-04-04T10:00:00.000Z",
      commandRunner: makeGitRunner({ "git status --short": "" }),
    });
    assert.deepEqual(context.changedFiles, []);
    assert.deepEqual(context.fileStatus, []);
  });

  it("upstream이 빈 문자열이면 null을 반환한다", () => {
    const cwd = createTempDir("triflux-handoff-no-upstream-");
    const context = collectHandoffContext({
      cwd,
      generatedAt: "2026-04-04T10:00:00.000Z",
      commandRunner: makeGitRunner({
        "git rev-list --left-right --count @{upstream}...HEAD": "",
      }),
    });
    assert.equal(context.upstream, null);
  });

  it("generatedAt 미지정 시 ISO 타임스탬프가 자동 생성된다", () => {
    const cwd = createTempDir("triflux-handoff-auto-timestamp-");
    const context = collectHandoffContext({
      cwd,
      commandRunner: makeGitRunner(),
    });
    assert.ok(typeof context.generatedAt === "string");
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(context.generatedAt));
  });

  it("fileStatus에 각 파일의 상태 코드가 포함된다", () => {
    const cwd = createTempDir("triflux-handoff-filestatus-");
    const context = collectHandoffContext({
      cwd,
      generatedAt: "2026-04-04T10:00:00.000Z",
      commandRunner: makeGitRunner({
        "git status --short": " M src/a.mjs\nA  src/b.mjs\n?? src/c.mjs\n",
      }),
    });
    assert.equal(context.fileStatus.length, 3);
    assert.equal(context.fileStatus[0].path, "src/a.mjs");
    assert.equal(context.fileStatus[0].status, "M");
    assert.equal(context.fileStatus[1].status, "A");
    assert.equal(context.fileStatus[2].status, "??");
  });
});

// ── buildHandoffPrompt ──

describe("buildHandoffPrompt()", () => {
  it("upstream이 있으면 ahead/behind 형식으로 표시한다", () => {
    const prompt = buildHandoffPrompt({
      generatedAt: "2026-04-04T10:00:00.000Z",
      target: "remote",
      repository: "triflux",
      branch: "feature/test",
      upstream: { ahead: 2, behind: 1 },
      cwd: "/tmp/repo",
      changedFiles: ["a.mjs"],
      diffStat: " a.mjs | 1 +\n",
      decisions: ["결정 1"],
      claudeMdPaths: ["/home/.claude/CLAUDE.md"],
    });

    assert.ok(prompt.includes("## TFX Remote Handoff"));
    assert.ok(prompt.includes("branch: feature/test (ahead 2, behind 1)"));
    assert.ok(prompt.includes("- a.mjs"));
    assert.ok(prompt.includes("- 결정 1"));
    assert.ok(prompt.includes("/home/.claude/CLAUDE.md"));
  });

  it("upstream이 null이면 unknown으로 표시한다", () => {
    const prompt = buildHandoffPrompt({
      generatedAt: "2026-04-04T10:00:00.000Z",
      target: "remote",
      repository: "triflux",
      branch: "main",
      upstream: null,
      cwd: "/tmp/repo",
      changedFiles: [],
      diffStat: "",
      decisions: [],
      claudeMdPaths: [],
    });

    assert.ok(prompt.includes("branch: main (unknown)"));
  });

  it("branch가 null이면 unknown으로 표시한다", () => {
    const prompt = buildHandoffPrompt({
      generatedAt: "2026-04-04T10:00:00.000Z",
      target: "local",
      repository: "triflux",
      branch: null,
      upstream: null,
      cwd: "/tmp/repo",
      changedFiles: [],
      diffStat: "",
      decisions: [],
      claudeMdPaths: [],
    });

    assert.ok(prompt.includes("branch: unknown (unknown)"));
  });

  it("변경 파일 없으면 '변경 파일 없음'을 표시한다", () => {
    const prompt = buildHandoffPrompt({
      generatedAt: "2026-04-04T10:00:00.000Z",
      target: "remote",
      repository: "triflux",
      branch: "main",
      upstream: null,
      cwd: "/tmp/repo",
      changedFiles: [],
      diffStat: "",
      decisions: [],
      claudeMdPaths: [],
    });

    assert.ok(prompt.includes("변경 파일 없음"));
  });

  it("결정사항이 없으면 '명시된 결정사항 없음'을 표시한다", () => {
    const prompt = buildHandoffPrompt({
      generatedAt: "2026-04-04T10:00:00.000Z",
      target: "remote",
      repository: "triflux",
      branch: "main",
      upstream: null,
      cwd: "/tmp/repo",
      changedFiles: [],
      diffStat: "",
      decisions: [],
      claudeMdPaths: [],
    });

    assert.ok(prompt.includes("명시된 결정사항 없음"));
  });

  it("claudeMdPaths가 비어있으면 '자동 탐지된 CLAUDE.md 없음'을 표시한다", () => {
    const prompt = buildHandoffPrompt({
      generatedAt: "2026-04-04T10:00:00.000Z",
      target: "remote",
      repository: "triflux",
      branch: "main",
      upstream: null,
      cwd: "/tmp/repo",
      changedFiles: [],
      diffStat: "",
      decisions: [],
      claudeMdPaths: [],
    });

    assert.ok(prompt.includes("자동 탐지된 CLAUDE.md 없음"));
  });

  it("diffStat이 없으면 '(diff stat 없음)'을 표시한다", () => {
    const prompt = buildHandoffPrompt({
      generatedAt: "2026-04-04T10:00:00.000Z",
      target: "remote",
      repository: "triflux",
      branch: "main",
      upstream: null,
      cwd: "/tmp/repo",
      changedFiles: [],
      diffStat: "",
      decisions: [],
      claudeMdPaths: [],
    });

    assert.ok(prompt.includes("(diff stat 없음)"));
  });

  it("프롬프트에 '다음 세션 지시' 섹션이 포함된다", () => {
    const prompt = buildHandoffPrompt({
      generatedAt: "2026-04-04T10:00:00.000Z",
      target: "remote",
      repository: "triflux",
      branch: "main",
      upstream: null,
      cwd: "/tmp/repo",
      changedFiles: [],
      diffStat: "",
      decisions: [],
      claudeMdPaths: [],
    });

    assert.ok(prompt.includes("### 다음 세션 지시"));
    assert.ok(prompt.includes("위 변경사항을 먼저 검토"));
  });

  it("여러 변경 파일과 결정사항을 각각 리스트로 표시한다", () => {
    const prompt = buildHandoffPrompt({
      generatedAt: "2026-04-04T10:00:00.000Z",
      target: "remote",
      repository: "triflux",
      branch: "main",
      upstream: null,
      cwd: "/tmp/repo",
      changedFiles: ["src/a.mjs", "src/b.mjs", "src/c.mjs"],
      diffStat: " 3 files changed\n",
      decisions: ["첫 번째 결정", "두 번째 결정"],
      claudeMdPaths: ["/home/.claude/CLAUDE.md", "/project/CLAUDE.md"],
    });

    assert.ok(prompt.includes("- src/a.mjs"));
    assert.ok(prompt.includes("- src/b.mjs"));
    assert.ok(prompt.includes("- src/c.mjs"));
    assert.ok(prompt.includes("- 첫 번째 결정"));
    assert.ok(prompt.includes("- 두 번째 결정"));
    assert.ok(prompt.includes("- /home/.claude/CLAUDE.md"));
    assert.ok(prompt.includes("- /project/CLAUDE.md"));
  });

  it("generatedAt과 target이 프롬프트 헤더에 포함된다", () => {
    const prompt = buildHandoffPrompt({
      generatedAt: "2026-04-04T10:00:00.000Z",
      target: "local",
      repository: "my-repo",
      branch: "dev",
      upstream: null,
      cwd: "/tmp/repo",
      changedFiles: [],
      diffStat: "",
      decisions: [],
      claudeMdPaths: [],
    });

    assert.ok(prompt.includes("generated_at: 2026-04-04T10:00:00.000Z"));
    assert.ok(prompt.includes("target: local"));
    assert.ok(prompt.includes("repository: my-repo"));
  });
});

// ── serializeHandoff ──

describe("serializeHandoff()", () => {
  it("결정사항 파일을 읽어 프롬프트를 생성한다", () => {
    const cwd = createTempDir("triflux-handoff-prompt-");
    const decisionFile = join(cwd, "decisions.md");
    writeFileSync(decisionFile, "- DB 스키마 동결\n- API 응답 필드 유지\n", "utf8");

    const result = serializeHandoff({
      cwd,
      decisionFile,
      generatedAt: "2026-04-04T10:00:00.000Z",
      commandRunner: createCommandRunner({
        "git rev-parse --show-toplevel": "/repo/triflux\n",
        "git rev-parse --abbrev-ref HEAD": "main\n",
        "git status --short": " M docs/prd/lake3-remote-handoff.md\n",
        "git diff --stat --no-color": " docs/prd/lake3-remote-handoff.md | 3 ++-\n",
        "git rev-list --left-right --count @{upstream}...HEAD": "0 0\n",
      }),
    });

    assert.equal(result.prompt.includes("## TFX Remote Handoff"), true);
    assert.equal(result.prompt.includes("- DB 스키마 동결"), true);
    assert.equal(result.prompt.includes("docs/prd/lake3-remote-handoff.md"), true);
    assert.equal(result.prompt.includes("branch: main"), true);
  });

  it("반환 객체에 context 필드와 prompt 필드가 모두 포함된다", () => {
    const cwd = createTempDir("triflux-handoff-serialize-fields-");
    const result = serializeHandoff({
      cwd,
      generatedAt: "2026-04-04T10:00:00.000Z",
      commandRunner: makeGitRunner(),
    });

    // context 필드 존재 확인
    assert.ok("generatedAt" in result);
    assert.ok("target" in result);
    assert.ok("cwd" in result);
    assert.ok("gitRoot" in result);
    assert.ok("repository" in result);
    assert.ok("branch" in result);
    assert.ok("upstream" in result);
    assert.ok("changedFiles" in result);
    assert.ok("fileStatus" in result);
    assert.ok("diffStat" in result);
    assert.ok("decisions" in result);
    assert.ok("claudeMdPaths" in result);
    // prompt 필드 존재 확인
    assert.ok("prompt" in result);
    assert.equal(typeof result.prompt, "string");
    assert.ok(result.prompt.includes("## TFX Remote Handoff"));
  });

  it("prompt는 context 데이터를 기반으로 생성된다", () => {
    const cwd = createTempDir("triflux-handoff-serialize-consistency-");
    const result = serializeHandoff({
      cwd,
      target: "local",
      decisions: ["테스트 결정"],
      generatedAt: "2026-04-04T10:00:00.000Z",
      commandRunner: makeGitRunner({
        "git rev-parse --abbrev-ref HEAD": "feature/x\n",
        "git status --short": " M app.mjs\n",
      }),
    });

    assert.equal(result.target, "local");
    assert.ok(result.prompt.includes("target: local"));
    assert.ok(result.prompt.includes("branch: feature/x"));
    assert.ok(result.prompt.includes("- app.mjs"));
    assert.ok(result.prompt.includes("- 테스트 결정"));
  });

  it("옵션 없이 호출해도 기본값으로 동작한다", () => {
    const cwd = createTempDir("triflux-handoff-serialize-defaults-");
    const result = serializeHandoff({
      cwd,
      commandRunner: makeGitRunner(),
    });

    assert.equal(result.target, "remote");
    assert.equal(typeof result.generatedAt, "string");
    assert.equal(typeof result.prompt, "string");
    assert.ok(result.prompt.length > 0);
  });
});
