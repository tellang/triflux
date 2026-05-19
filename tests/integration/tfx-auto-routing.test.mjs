import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { decideDispatchMode } from "../../hub/lib/tfx-route-args.mjs";

describe("Issue #281 - auto router code-change swarm dispatch", () => {
  let cwd = null;

  function setupRepo({ dirty = false }) {
    cwd = mkdtempSync(join(tmpdir(), "tfx-281-int-"));
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd });
    writeFileSync(join(cwd, "seed.txt"), "seed\n");
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["commit", "-m", "init", "-q"], { cwd });
    if (dirty) writeFileSync(join(cwd, "change.txt"), "x\n");
    return cwd;
  }

  afterEach(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    cwd = null;
  });

  it("case 1: clean repo + 2+ tasks -> multi", () => {
    setupRepo({ dirty: false });

    const result = decideDispatchMode({ tasks: ["t1", "t2"] }, { cwd });

    assert.equal(result.mode, "multi");
    assert.equal(result.escalated, false);
    assert.equal(result.warning, null);
  });

  it("case 2: dirty repo + 2+ tasks -> swarm auto escalate", () => {
    setupRepo({ dirty: true });

    const result = decideDispatchMode({ tasks: ["t1", "t2"] }, { cwd });

    assert.equal(result.mode, "swarm");
    assert.equal(result.escalated, true);
    assert.match(result.warning, /자동 escalate/);
    assert.match(result.warning, /Issue #281/);
  });

  it("case 3: dirty repo + explicit --parallel 3 -> multi with warning", () => {
    setupRepo({ dirty: true });

    const result = decideDispatchMode(
      { tasks: ["t1", "t2"], parallel: 3 },
      { cwd },
    );

    assert.equal(result.mode, "multi");
    assert.equal(result.escalated, false);
    assert.match(result.warning, /WARNING: 코드 변경/);
    assert.match(result.warning, /사용자 명시.*존중/);
  });
});
