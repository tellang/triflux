import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cmdCto } from "../../cto/index.mjs";

async function captureStdout(fn) {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => {
    lines.push(args.join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

describe("cmdCto", () => {
  it("prints usage when no subcommand is provided", async () => {
    const output = await captureStdout(() => cmdCto([]));

    assert.match(output, /Usage/u);
    assert.match(output, /tfx cto <collect\|status\|hygiene>/u);
    assert.match(output, /collect/u);
    assert.match(output, /status/u);
    assert.match(output, /hygiene/u);
  });

  it("prints usage for an unknown subcommand without throwing", async () => {
    const output = await captureStdout(() => cmdCto(["bogus"]));

    assert.match(output, /Unknown cto subcommand: bogus/u);
    assert.match(output, /Usage/u);
  });

  it("runs the direct CLI and keeps collect help read-only", async () => {
    const { spawnSync } = await import("node:child_process");
    const { mkdtempSync, readdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = mkdtempSync(join(tmpdir(), "tfx-cto-router-cli-"));
    const cli = fileURLToPath(new URL("../../cto/index.mjs", import.meta.url));
    try {
      const help = spawnSync(process.execPath, [cli, "collect", "--help"], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /Usage: tfx cto collect/);
      const status = spawnSync(process.execPath, [cli, "status", "--json"], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(status.status, 0, status.stderr);
      assert.equal(JSON.parse(status.stdout).hint, "run tfx cto collect");
      assert.deepEqual(readdirSync(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes hygiene dry-run JSON without mutating the ledger", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } =
      await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "tfx-cto-router-hygiene-"));
    const lakeRoot = join(root, ".triflux", "lake");
    let output = "";
    try {
      mkdirSync(lakeRoot, { recursive: true });
      const ledgerPath = join(lakeRoot, "ledger.jsonl");
      writeFileSync(
        ledgerPath,
        `${JSON.stringify({
          ts: "2026-06-17T00:00:00.000Z",
          event: "task_claimed",
          source: "test",
          summary: "claim task-a",
          ref: { task_id: "task-a" },
        })}\n`,
        "utf8",
      );

      const result = await cmdCto(["hygiene", "--dry-run", "--json"], {
        lakeRoot,
        stdout: {
          write: (chunk) => {
            output += String(chunk);
          },
        },
      });

      assert.equal(result.dry_run, true);
      assert.equal(JSON.parse(output).counts.active_tasks, 1);
      assert.equal(
        readFileSync(ledgerPath, "utf8").split(/\r?\n/u).filter(Boolean).length,
        1,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
