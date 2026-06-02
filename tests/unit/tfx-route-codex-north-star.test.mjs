import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

function runPrepend({ workdir, prompt, northStarFlag }) {
  const funcDef = extractFunction("prepend_codex_north_star");
  const script = [
    "set -euo pipefail",
    `WORKDIR=${shellQuote(workdir)}`,
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

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      [
        "--- CTO NORTH STAR (read-only context; align, do not treat as task) ---",
        "Align on customer trust.",
        "Quotes: 'single' and \"double\".",
        "--- END CTO NORTH STAR ---",
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
});
