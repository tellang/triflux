import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { BASH_EXE } from "../helpers/bash-path.mjs";

const routeSource = readFileSync(
  join(process.cwd(), "scripts", "tfx-route.sh"),
  "utf8",
);

// north-star 테스트와 동일한 brace-matching 함수 추출기.
function extractFunction(funcName) {
  const start = routeSource.indexOf(`${funcName}() {`);
  assert.ok(start >= 0, `${funcName} 정의를 찾을 수 없음`);
  let depth = 0;
  for (let i = start; i < routeSource.length; i += 1) {
    if (routeSource[i] === "{") depth += 1;
    if (routeSource[i] === "}") {
      depth -= 1;
      if (depth === 0) return routeSource.slice(start, i + 1);
    }
  }
  throw new Error(`${funcName} 끝을 찾을 수 없음`);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runFunc({ funcName, env = {}, callArg }) {
  const funcDef = extractFunction(funcName);
  const script = [
    "set -euo pipefail",
    ...Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`),
    funcDef,
    `${funcName} ${shellQuote(callArg)}`,
  ].join("\n");
  return spawnSync(BASH_EXE, ["-c", script], { encoding: "utf8" });
}

describe("tfx-route skill injection", () => {
  const cleanupDirs = [];
  after(() => {
    for (const dir of cleanupDirs)
      rmSync(dir, { recursive: true, force: true });
  });

  function fixtureSkillsDir(name, body) {
    const dir = mkdtempSync(join(tmpdir(), "tfx-skills-"));
    cleanupDirs.push(dir);
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), body);
    return dir;
  }

  it("prepends the delimited skill block when TFX_INJECT_SKILL is set", () => {
    const skillsDir = fixtureSkillsDir(
      "demo",
      "Methodology step A.\nStep B.\n",
    );
    const workdir = mkdtempSync(join(tmpdir(), "tfx-workspace-"));
    cleanupDirs.push(workdir);
    const result = runFunc({
      funcName: "prepend_skill",
      env: {
        TFX_INJECT_SKILL: "demo",
        TFX_SKILLS_DIR: skillsDir,
        WORKDIR: workdir,
      },
      callArg: "Do the task.\n--flag-like text stays literal.",
    });
    const resolvedWorkdir = realpathSync(workdir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      [
        `--- SKILL: demo (workspace: ${resolvedWorkdir}; apply this methodology to the task below) ---`,
        "Methodology step A.",
        "Step B.",
        "--- END SKILL ---",
        "Do the task.",
        "--flag-like text stays literal.",
      ].join("\n"),
    );
  });

  it("is a no-op when TFX_INJECT_SKILL is unset", () => {
    const prompt = "Original prompt stays first.\n--flag literal.";
    const result = runFunc({ funcName: "prepend_skill", callArg: prompt });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, prompt);
  });

  it("is a no-op (prompt unchanged on stdout) when the skill file is absent", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "tfx-skills-empty-"));
    cleanupDirs.push(emptyDir);
    const prompt = "Prompt with no skill.";
    const result = runFunc({
      funcName: "prepend_skill",
      env: { TFX_INJECT_SKILL: "missing", TFX_SKILLS_DIR: emptyDir },
      callArg: prompt,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, prompt);
    assert.match(result.stderr, /스킬을 찾지 못함/);
  });

  it("rejects a skill name with path separators (no traversal)", () => {
    const skillsDir = fixtureSkillsDir("demo", "Guidance.\n");
    const prompt = "Prompt body.";
    const result = runFunc({
      funcName: "prepend_skill",
      env: { TFX_INJECT_SKILL: "../../etc/demo", TFX_SKILLS_DIR: skillsDir },
      callArg: prompt,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, prompt);
    assert.match(result.stderr, /경로 구분자/);
  });

  it("preserves $ / ₩ / backslash / --flag literally (parse-safe)", () => {
    const skillsDir = fixtureSkillsDir("demo", "Guidance.\n");
    const prompt = "Cost is $FOO and ₩100, path C:\\temp\\x, and --dry-run.";
    const result = runFunc({
      funcName: "prepend_skill",
      env: { TFX_INJECT_SKILL: "demo", TFX_SKILLS_DIR: skillsDir },
      callArg: prompt,
    });
    assert.equal(result.status, 0, result.stderr);
    // 프롬프트는 블록 뒤에 그대로 붙으므로 stdout 이 원본 프롬프트로 끝나야 한다.
    assert.ok(
      result.stdout.endsWith(prompt),
      `프롬프트가 리터럴로 보존되지 않음:\n${result.stdout}`,
    );
    assert.ok(result.stdout.includes("$FOO"));
    assert.ok(result.stdout.includes("₩100"));
    assert.ok(result.stdout.includes("C:\\temp\\x"));
  });

  it("appends the agy anti-overclaim discipline block at the END by default", () => {
    const prompt = "Implement the feature.";
    const workdir = mkdtempSync(join(tmpdir(), "tfx-agy-root-"));
    cleanupDirs.push(workdir);
    const result = runFunc({
      funcName: "append_agy_anti_overclaim",
      env: { WORKDIR: workdir },
      callArg: prompt,
    });
    const resolvedWorkdir = realpathSync(workdir);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.startsWith(prompt), "프롬프트가 먼저 와야 함");
    assert.match(result.stdout, /COMPLETION & GROUNDING DISCIPLINE/);
    assert.match(
      result.stdout,
      new RegExp(
        `Repository root \\(absolute\\): ${resolvedWorkdir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\. Resolve every relative path against this root only\\.`,
      ),
    );
    assert.match(result.stdout, /Before any file write, git add\/commit\/push/);
    assert.match(result.stdout, /No Info \/ 확인 불가/);
    // blanket "do not guess" 대신 abstention 프레이밍을 쓴다 (Gemini 3 가이드 caveat).
    assert.match(result.stdout, /prefer accurate abstention/);
    assert.match(
      result.stdout,
      /The task's own final output\/format constraints above remain in effect\./,
    );
  });

  it("is a no-op for anti-overclaim when TFX_AGY_ANTI_OVERCLAIM=0", () => {
    const prompt = "Implement the feature.";
    const result = runFunc({
      funcName: "append_agy_anti_overclaim",
      env: { TFX_AGY_ANTI_OVERCLAIM: "0" },
      callArg: prompt,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, prompt);
  });

  it("wires the codex lane to call prepend_skill before dispatch", () => {
    const codexIdx = routeSource.indexOf("_codex_north_star_file=");
    assert.ok(codexIdx >= 0, "codex lane not found");
    const lane = routeSource.slice(
      codexIdx,
      routeSource.indexOf('codex_transport_effective="exec"', codexIdx),
    );
    assert.match(lane, /TFX_INJECT_SKILL/);
    assert.match(lane, /prepend_skill "\$FULL_PROMPT"/);
  });

  it("wires the antigravity lane to call prepend_skill + append_agy_anti_overclaim", () => {
    const laneStart = routeSource.indexOf(
      'elif [[ "$CLI_TYPE" == "antigravity" ]]; then',
    );
    assert.ok(laneStart >= 0, "antigravity lane not found");
    const lane = routeSource.slice(
      laneStart,
      routeSource.indexOf("run_antigravity_exec", laneStart),
    );
    assert.match(lane, /prepend_skill "\$FULL_PROMPT"/);
    assert.match(
      lane,
      /append_agy_anti_overclaim "\$FULL_PROMPT" "\$\{WORKDIR:-\$PWD\}"/,
    );
  });
});
