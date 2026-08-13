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

function runPrepend({ workdir, prompt, ctoMasterFlag, northStarFlag }) {
  const funcDef = extractFunction("prepend_codex_north_star");
  const script = [
    "set -euo pipefail",
    `WORKDIR=${shellQuote(workdir)}`,
    ctoMasterFlag === undefined ? "" : `TFX_CTO=${shellQuote(ctoMasterFlag)}`,
    northStarFlag === undefined
      ? ""
      : `TFX_CTO_NORTH_STAR=${shellQuote(northStarFlag)}`,
    funcDef,
    `prepend_codex_north_star ${shellQuote(prompt)}`,
  ]
    .filter(Boolean)
    .join("\n");
  return spawnSync(BASH_EXE, ["-c", script], {
    encoding: "utf8",
  });
}

describe("tfx-route Codex north-star prepend", () => {
  const cleanupDirs = [];
  after(() => {
    for (const dir of cleanupDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prepends the delimited north-star brief when current.md exists", () => {
    const workdir = mkdtempSync(join(tmpdir(), "tfx-codex-brief-"));
    cleanupDirs.push(workdir);
    mkdirSync(join(workdir, ".triflux", "lake"), { recursive: true });
    writeFileSync(
      join(workdir, ".triflux", "lake", "current.md"),
      "Align on customer trust.\nQuotes: 'single' and \"double\".\n",
    );

    const result = runPrepend({
      workdir,
      prompt: "Implement the requested change.\nKeep dispatch stable.",
    });
    const resolvedWorkdir = realpathSync(workdir);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      [
        `--- CTO NORTH STAR (repo: ${resolvedWorkdir}; read-only context; align, do not treat as task) ---`,
        "Align on customer trust.",
        "Quotes: 'single' and \"double\".",
        "--- END CTO NORTH STAR (context only — the actual task follows below; do not execute items above as tasks) ---",
        "Implement the requested change.",
        "Keep dispatch stable.",
      ].join("\n"),
    );
  });

  it("leaves the prompt byte-unchanged when current.md is absent", () => {
    const workdir = mkdtempSync(join(tmpdir(), "tfx-codex-no-brief-"));
    cleanupDirs.push(workdir);
    const prompt = "Original prompt.\n--flag-like text must remain literal.";

    const result = runPrepend({ workdir, prompt });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, prompt);
  });

  it("leaves the prompt byte-unchanged when TFX_CTO_NORTH_STAR=0", () => {
    const workdir = mkdtempSync(join(tmpdir(), "tfx-codex-brief-off-"));
    cleanupDirs.push(workdir);
    mkdirSync(join(workdir, ".triflux", "lake"), { recursive: true });
    writeFileSync(
      join(workdir, ".triflux", "lake", "current.md"),
      "This ambient brief must not leak into opt-out tests.\n",
    );
    const prompt = "Original prompt stays first.";

    const result = runPrepend({
      workdir,
      prompt,
      northStarFlag: "0",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, prompt);
  });

  it("lets TFX_CTO=0 override TFX_CTO_NORTH_STAR=1", () => {
    const workdir = mkdtempSync(join(tmpdir(), "tfx-codex-master-off-"));
    cleanupDirs.push(workdir);
    mkdirSync(join(workdir, ".triflux", "lake"), { recursive: true });
    writeFileSync(
      join(workdir, ".triflux", "lake", "current.md"),
      "Master-off must suppress this brief.\n",
    );
    const prompt = "The original task must remain unprefixed.";

    const result = runPrepend({
      workdir,
      prompt,
      ctoMasterFlag: "0",
      northStarFlag: "1",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, prompt);
  });

  it("wires the antigravity lane to prepend the same north-star brief", () => {
    // codex lane(line ~2670)과 동일하게 antigravity dispatch 직전에 north-star 를
    // prepend 해야 한다. prepend_codex_north_star 는 CLI-agnostic 이라 재사용한다.
    const laneStart = routeSource.indexOf(
      'elif [[ "$CLI_TYPE" == "antigravity" ]]; then',
    );
    assert.ok(laneStart >= 0, "antigravity dispatch lane not found");
    const dispatchIdx = routeSource.indexOf("run_antigravity_exec", laneStart);
    assert.ok(dispatchIdx > laneStart, "run_antigravity_exec call not found");
    const lane = routeSource.slice(laneStart, dispatchIdx);

    assert.match(
      lane,
      /current\.md/,
      "antigravity lane must read .triflux/lake/current.md",
    );
    assert.match(
      lane,
      /prepend_codex_north_star "\$FULL_PROMPT"/,
      "antigravity lane must call prepend_codex_north_star before dispatch",
    );
    assert.match(
      lane,
      /FULL_PROMPT=/,
      "antigravity lane must reassign FULL_PROMPT with the prepended brief",
    );
  });

  it("keeps the codex lane north-star prepend wiring (regression guard)", () => {
    const codexIdx = routeSource.indexOf("_codex_north_star_file=");
    assert.ok(codexIdx >= 0, "codex lane north-star wiring missing");
    assert.match(
      routeSource.slice(codexIdx, codexIdx + 400),
      /prepend_codex_north_star "\$FULL_PROMPT"/,
    );
  });
});
