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
    assert.match(
      output,
      /tfx cto <collect\|status\|dashboard\|hygiene\|event>/u,
    );
    assert.match(output, /collect/u);
    assert.match(output, /status/u);
    assert.match(output, /dashboard/u);
    assert.match(output, /hygiene/u);
    assert.match(output, /event/u);
  });

  it("prints usage for an unknown subcommand without throwing", async () => {
    const output = await captureStdout(() => cmdCto(["bogus"]));

    assert.match(output, /Unknown cto subcommand: bogus/u);
    assert.match(output, /Usage/u);
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
        synapseReader: async () => ({ sessions: [] }),
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

  it("routes context-save wrapper lineage events into the CTO ledger", async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "tfx-cto-router-event-"));
    const lakeRoot = join(root, ".triflux", "lake");
    let output = "";
    try {
      const result = await cmdCto(
        [
          "event",
          "context-save",
          "--checkpoint-id",
          "cp-434",
          "--session-id",
          "session-434",
          "--artifact-path",
          "/tmp/cp-434.md",
          "--issue",
          "434",
          "--json",
        ],
        {
          rootDir: root,
          lakeRoot,
          stdout: {
            write: (chunk) => {
              output += String(chunk);
            },
          },
        },
      );

      assert.equal(result.appended, true);
      assert.equal(
        result.owner_surface,
        "gstack context-save -> tfx cto event context-save",
      );
      const printed = JSON.parse(output);
      assert.equal(printed.appended, true);
      assert.equal(printed.event.event, "checkpoint_saved");
      assert.equal(printed.event.source, "gstack_context_save");
      assert.equal(printed.event.ref.checkpoint_id, "cp-434");
      assert.equal(printed.event.ref.session_id, "session-434");
      assert.deepEqual(printed.event.ref.issue_refs, [434]);
      assert.deepEqual(printed.event.ref.actor, { cli: "gstack context-save" });

      const ledgerRows = readFileSync(join(lakeRoot, "ledger.jsonl"), "utf8")
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.equal(ledgerRows.length, 1);
      assert.equal(ledgerRows[0].event, "checkpoint_saved");
      assert.equal(ledgerRows[0].ref.checkpoint_id, "cp-434");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes PR lifecycle wrapper events into the CTO ledger", async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "tfx-cto-router-pr-event-"));
    const lakeRoot = join(root, ".triflux", "lake");
    let output = "";
    try {
      const result = await cmdCto(
        [
          "event",
          "pr-created",
          "--pr",
          "#434",
          "--branch",
          "fix/cto-wrapper-lineage-events",
          "--summary",
          "PR #434 created",
          "--json",
        ],
        {
          rootDir: root,
          lakeRoot,
          stdout: {
            write: (chunk) => {
              output += String(chunk);
            },
          },
        },
      );

      assert.equal(result.appended, true);
      assert.equal(
        result.owner_surface,
        "gh pr create/merge/close -> tfx cto event pr-created",
      );
      const printed = JSON.parse(output);
      assert.equal(printed.event.event, "pr_created");
      assert.equal(printed.event.source, "tfx_pr_lifecycle");
      assert.deepEqual(printed.event.ref.pr_refs, [434]);
      assert.equal(printed.event.ref.branch, "fix/cto-wrapper-lineage-events");
      assert.deepEqual(printed.event.ref.actor, { cli: "gh pr create" });

      const ledgerRows = readFileSync(join(lakeRoot, "ledger.jsonl"), "utf8")
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.equal(ledgerRows.length, 1);
      assert.equal(ledgerRows[0].event, "pr_created");
      assert.deepEqual(ledgerRows[0].ref.pr_refs, [434]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
