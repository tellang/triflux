import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runSteward } from "../../cto/steward.mjs";

function tempRoot(prefix = "tfx-cto-steward-") {
  const rootDir = mkdtempSync(join(tmpdir(), prefix));
  return {
    rootDir,
    lakeRoot: join(rootDir, ".triflux", "lake"),
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}

function silentStdoutBuffer() {
  let output = "";
  return {
    stdout: {
      write: (chunk) => {
        output += String(chunk);
        return true;
      },
    },
    get output() {
      return output;
    },
  };
}

function stubbedFns(calls) {
  return {
    collectFn: async (args, opts) => {
      calls.push({
        kind: "collect",
        args,
        rootDir: opts.rootDir,
        lakeRoot: opts.lakeRoot,
      });
      opts.stdout?.write("nested collect output must be hidden\n");
      return {
        schema_version: "cto-lake.v1",
        generated_at: "2026-07-06T00:00:00.000Z",
      };
    },
    hygieneFn: async (args, opts) => {
      calls.push({
        kind: "hygiene",
        args,
        rootDir: opts.rootDir,
        lakeRoot: opts.lakeRoot,
      });
      opts.stdout?.write("nested hygiene output must be hidden\n");
      return {
        schema_version: "cto-hygiene.v1",
        dry_run: args.includes("--dry-run"),
      };
    },
  };
}

describe("runSteward", () => {
  it("defaults to collect then one-shot hygiene dry-run", async () => {
    const calls = [];
    const io = silentStdoutBuffer();
    const result = await runSteward([], {
      ...stubbedFns(calls),
      stdout: io.stdout,
      rootDir: "/repo",
      lakeRoot: "/repo/.triflux/lake",
    });

    assert.equal(result.schema_version, "cto-steward.v1");
    assert.equal(result.mode, "dry-run");
    assert.equal(result.watch, false);
    assert.equal(result.max_runs, null);
    assert.equal(result.collect_enabled, true);
    assert.equal(result.run_count, 1);
    assert.deepEqual(
      calls.map((call) => call.kind),
      ["collect", "hygiene"],
    );
    assert.deepEqual(calls[0].args, []);
    assert.deepEqual(calls[1].args, ["--dry-run", "--json"]);
  });

  it("--apply calls hygiene with explicit apply mode", async () => {
    const calls = [];
    const result = await runSteward(["--apply"], {
      ...stubbedFns(calls),
      stdout: silentStdoutBuffer().stdout,
      rootDir: "/repo",
      lakeRoot: "/repo/.triflux/lake",
    });

    assert.equal(result.mode, "apply");
    assert.deepEqual(calls.find((call) => call.kind === "hygiene").args, [
      "--apply",
      "--json",
    ]);
  });

  it("rejects mutually exclusive, unknown, missing, and invalid flags", async () => {
    await assert.rejects(
      () =>
        runSteward(["--apply", "--dry-run"], {
          stdout: silentStdoutBuffer().stdout,
        }),
      /only one of --apply or --dry-run/u,
    );
    await assert.rejects(
      () => runSteward(["--bogus"], { stdout: silentStdoutBuffer().stdout }),
      /unknown tfx cto steward flag/u,
    );
    await assert.rejects(
      () => runSteward(["--max-runs"], { stdout: silentStdoutBuffer().stdout }),
      /--max-runs requires a value/u,
    );
    await assert.rejects(
      () =>
        runSteward(["--max-runs", "0"], {
          stdout: silentStdoutBuffer().stdout,
        }),
      /--max-runs must be a positive integer/u,
    );
    await assert.rejects(
      () =>
        runSteward(["--interval-ms", "-1"], {
          stdout: silentStdoutBuffer().stdout,
        }),
      /--interval-ms must be a non-negative integer/u,
    );
  });

  it("--watch --max-runs loops and sleeps between runs", async () => {
    const calls = [];
    const sleeps = [];
    const result = await runSteward(
      ["--watch", "--max-runs", "3", "--interval-ms", "10"],
      {
        ...stubbedFns(calls),
        sleepFn: async (ms) => sleeps.push(ms),
        acquireLoopLockFn: async () => null,
        stdout: silentStdoutBuffer().stdout,
        rootDir: "/repo",
        lakeRoot: "/repo/.triflux/lake",
      },
    );

    assert.equal(result.run_count, 3);
    assert.equal(calls.filter((call) => call.kind === "collect").length, 3);
    assert.equal(calls.filter((call) => call.kind === "hygiene").length, 3);
    assert.deepEqual(sleeps, [10, 10]);
  });

  it("--watch without --max-runs keeps only bounded latest-run state", async () => {
    const calls = [];
    let sleepCount = 0;
    const abortAfterThirdRun = async () => {
      sleepCount += 1;
      if (sleepCount >= 3) {
        const error = new Error("test watch stop");
        error.name = "AbortError";
        throw error;
      }
    };

    const result = await runSteward(["--watch", "--interval-ms", "0"], {
      ...stubbedFns(calls),
      sleepFn: abortAfterThirdRun,
      acquireLoopLockFn: async () => null,
      stdout: silentStdoutBuffer().stdout,
      rootDir: "/repo",
      lakeRoot: "/repo/.triflux/lake",
    });

    assert.equal(result.watch, true);
    assert.equal(result.max_runs, null);
    assert.equal(result.run_count, 3);
    assert.equal(result.retained_run_count, 0);
    assert.deepEqual(result.runs, []);
    assert.equal(result.latest_run.index, 3);
    assert.deepEqual(result.latest_run.hygiene, result.last_hygiene);
    assert.equal(calls.filter((call) => call.kind === "collect").length, 3);
    assert.equal(calls.filter((call) => call.kind === "hygiene").length, 3);
  });

  it("rejects --watch --json without --max-runs", async () => {
    await assert.rejects(
      () =>
        runSteward(["--watch", "--json"], {
          stdout: silentStdoutBuffer().stdout,
        }),
      /--watch --json requires --max-runs/u,
    );
    await assert.rejects(
      () =>
        runSteward(["--watch"], {
          json: true,
          stdout: silentStdoutBuffer().stdout,
        }),
      /--watch --json requires --max-runs/u,
    );
  });

  it("keeps bounded --watch --max-runs --json parseable", async () => {
    const calls = [];
    const io = silentStdoutBuffer();
    const result = await runSteward(
      ["--watch", "--max-runs", "2", "--json", "--interval-ms", "0"],
      {
        ...stubbedFns(calls),
        sleepFn: async () => {},
        acquireLoopLockFn: async () => null,
        stdout: io.stdout,
        rootDir: "/repo",
        lakeRoot: "/repo/.triflux/lake",
      },
    );
    const output = JSON.parse(io.output);

    assert.equal(result.run_count, 2);
    assert.equal(output.schema_version, "cto-steward.v1");
    assert.equal(output.run_count, 2);
    assert.equal(output.retained_run_count, 2);
    assert.equal(output.runs.length, 2);
    assert.equal(output.latest_run.index, 2);
  });

  it("passes rootDir and lakeRoot to inner commands", async () => {
    const calls = [];
    await runSteward(["--no-collect"], {
      ...stubbedFns(calls),
      stdout: silentStdoutBuffer().stdout,
      rootDir: "/tmp/root-a",
      lakeRoot: "/tmp/root-a/.triflux/lake-a",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, "hygiene");
    assert.equal(calls[0].rootDir, "/tmp/root-a");
    assert.equal(calls[0].lakeRoot, "/tmp/root-a/.triflux/lake-a");
  });

  it("collect failure is fail-fast and hygiene is not called", async () => {
    let hygieneCalls = 0;
    await assert.rejects(
      () =>
        runSteward([], {
          collectFn: async () => {
            throw new Error("collect failed");
          },
          hygieneFn: async () => {
            hygieneCalls += 1;
          },
          stdout: silentStdoutBuffer().stdout,
        }),
      /collect failed/u,
    );
    assert.equal(hygieneCalls, 0);
  });

  it("--json output is isolated and parseable as one JSON object", async () => {
    const calls = [];
    const io = silentStdoutBuffer();
    const result = await runSteward(["--json"], {
      ...stubbedFns(calls),
      stdout: io.stdout,
      rootDir: "/repo",
      lakeRoot: "/repo/.triflux/lake",
    });

    assert.equal(JSON.parse(io.output).schema_version, "cto-steward.v1");
    assert.equal(JSON.parse(io.output).run_count, 1);
    assert.equal(io.output.match(/cto-steward\.v1/gu).length, 1);
    assert.equal(result.run_count, 1);
    assert.doesNotMatch(io.output, /nested collect output/u);
    assert.doesNotMatch(io.output, /nested hygiene output/u);
  });

  it("does not write steward telemetry into current.json", async () => {
    const { rootDir, lakeRoot, cleanup } = tempRoot("tfx-cto-steward-current-");
    try {
      const io = silentStdoutBuffer();
      await runSteward(["--json"], {
        collectFn: async (_args, opts) => {
          mkdirSync(opts.lakeRoot, { recursive: true });
          const current = {
            schema_version: "cto-lake.v1",
            repo: { root: opts.rootDir },
          };
          writeFileSync(
            join(opts.lakeRoot, "current.json"),
            `${JSON.stringify(current)}\n`,
            "utf8",
          );
          return current;
        },
        hygieneFn: async () => ({
          schema_version: "cto-hygiene.v1",
          dry_run: true,
          rows: [],
        }),
        rootDir,
        lakeRoot,
        stdout: io.stdout,
      });
      const current = JSON.parse(
        readFileSync(join(lakeRoot, "current.json"), "utf8"),
      );
      assert.equal(Object.hasOwn(current, "runs"), false);
      assert.equal(Object.hasOwn(current, "last_hygiene"), false);
    } finally {
      cleanup();
    }
  });

  it("live-overlay stale row apply는 session_stale을 만들지 않고 이동 불가면 ack 없이 skip한다", async () => {
    const { rootDir, lakeRoot, cleanup } = tempRoot("tfx-cto-steward-apply-");
    try {
      mkdirSync(lakeRoot, { recursive: true });
      const result = await runSteward(["--no-collect", "--apply", "--json"], {
        rootDir,
        lakeRoot,
        stdout: silentStdoutBuffer().stdout,
        overlay: {
          live_sessions: [
            {
              sessionId: "session-stale-1",
              phase: "stale",
              started_at: "2026-07-06T00:00:00.000Z",
            },
          ],
        },
      });

      // T4 executor 계약: 이동 불가(artifact 없음) row는 ack 없이 skip — 가짜 성공 금지.
      assert.equal(result.last_hygiene.apply.applied_count, 0);
      const sessionOp = result.last_hygiene.apply.actions.operations.find(
        (operation) => operation.id === "session-stale-1",
      );
      assert.equal(sessionOp.status, "skipped");
      assert.equal(sessionOp.reason, "missing_artifact_path");
      const events = existsSync(join(lakeRoot, "ledger.jsonl"))
        ? readFileSync(join(lakeRoot, "ledger.jsonl"), "utf8")
            .split(/\r?\n/u)
            .filter(Boolean)
            .map((line) => JSON.parse(line).event)
        : [];
      assert.equal(events.includes("session_stale"), false);
      assert.equal(events.includes("hygiene_applied"), false);
    } finally {
      cleanup();
    }
  });

  it("superseded checkpoint artifact remains after apply", async () => {
    const { rootDir, lakeRoot, cleanup } = tempRoot(
      "tfx-cto-steward-checkpoint-",
    );
    try {
      mkdirSync(lakeRoot, { recursive: true });
      const artifactPath = join(rootDir, "checkpoint-old.md");
      writeFileSync(artifactPath, "old checkpoint\n", "utf8");
      writeFileSync(
        join(lakeRoot, "ledger.jsonl"),
        [
          {
            ts: "2026-07-06T00:00:00.000Z",
            event: "checkpoint_saved",
            source: "test",
            summary: "old checkpoint",
            ref: {
              session_id: "s1",
              checkpoint_id: "cp-old",
              artifact_path: artifactPath,
            },
          },
          {
            ts: "2026-07-06T00:01:00.000Z",
            event: "checkpoint_saved",
            source: "test",
            summary: "new checkpoint",
            ref: {
              session_id: "s1",
              checkpoint_id: "cp-new",
              artifact_path: join(rootDir, "checkpoint-new.md"),
            },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
        "utf8",
      );

      const result = await runSteward(["--no-collect", "--apply", "--json"], {
        rootDir,
        lakeRoot,
        stdout: silentStdoutBuffer().stdout,
        synapseReader: async () => ({ sessions: [] }),
      });

      assert.equal(existsSync(artifactPath), true);
      // lake 밖 산출물은 이동/ack 없이 skip으로 정직하게 보고된다 (가짜 성공 금지).
      assert.equal(result.last_hygiene.apply.applied_count, 0);
      const outsideOp = result.last_hygiene.apply.actions.operations.find(
        (operation) => operation.id === "cp-old",
      );
      assert.equal(outsideOp.status, "skipped");
      assert.equal(outsideOp.reason, "source_outside_lake");
      const events = readFileSync(join(lakeRoot, "ledger.jsonl"), "utf8")
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line).event);
      assert.equal(
        events.filter((event) => event === "hygiene_applied").length,
        0,
      );
      assert.equal(events.includes("session_stale"), false);
    } finally {
      cleanup();
    }
  });

  it("TFX_CTO kill-switch가 켜져 있으면 collect/hygiene 없이 disabled로 종료한다", async () => {
    const calls = [];
    const io = silentStdoutBuffer();
    const result = await runSteward(["--watch", "--max-runs", "3"], {
      ...stubbedFns(calls),
      isCtoDisabledFn: () => true,
      acquireLoopLockFn: async () => {
        throw new Error("lock must not be acquired when disabled");
      },
      stdout: io.stdout,
      rootDir: "/repo",
      lakeRoot: "/repo/.triflux/lake",
    });

    assert.equal(result.disabled, true);
    assert.equal(result.stopped_reason, "disabled");
    assert.equal(result.run_count, 0);
    assert.equal(calls.length, 0);
    assert.match(io.output, /disabled by TFX_CTO kill-switch/u);
  });

  it("TFX_CTO=0 실제 env로도 kill-switch가 동작한다", async () => {
    const previous = process.env.TFX_CTO;
    process.env.TFX_CTO = "0";
    try {
      const calls = [];
      const result = await runSteward([], {
        ...stubbedFns(calls),
        stdout: silentStdoutBuffer().stdout,
        rootDir: "/repo",
        lakeRoot: "/repo/.triflux/lake",
      });
      assert.equal(result.disabled, true);
      assert.equal(calls.length, 0);
    } finally {
      if (previous === undefined) delete process.env.TFX_CTO;
      else process.env.TFX_CTO = previous;
    }
  });

  it("kill-switch가 watch 도중 켜지면 다음 cycle에서 멈춘다", async () => {
    const calls = [];
    let disabled = false;
    const result = await runSteward(["--watch", "--max-runs", "5"], {
      ...stubbedFns(calls),
      isCtoDisabledFn: () => disabled,
      acquireLoopLockFn: async () => null,
      sleepFn: async () => {
        disabled = true;
      },
      stdout: silentStdoutBuffer().stdout,
      rootDir: "/repo",
      lakeRoot: "/repo/.triflux/lake",
    });

    assert.equal(result.run_count, 1);
    assert.equal(result.stopped_reason, "disabled");
  });

  it("watch 루프는 lake당 단일 인스턴스 — 실제 락이 두 번째 진입을 거절한다", async () => {
    const { rootDir, lakeRoot, cleanup } = tempRoot("tfx-cto-steward-lock-");
    try {
      const calls = [];
      let releaseSecondAttempt = null;
      const secondAttempt = new Promise((resolve) => {
        releaseSecondAttempt = resolve;
      });
      const first = runSteward(["--watch", "--max-runs", "2"], {
        ...stubbedFns(calls),
        sleepFn: async () => {
          await secondAttempt;
        },
        stdout: silentStdoutBuffer().stdout,
        rootDir,
        lakeRoot,
      });

      // 첫 인스턴스가 락을 쥔 상태에서 두 번째 watch 진입은 즉시 거절돼야 한다.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await assert.rejects(
        () =>
          runSteward(["--watch", "--max-runs", "1"], {
            ...stubbedFns([]),
            stdout: silentStdoutBuffer().stdout,
            rootDir,
            lakeRoot,
          }),
        /steward lock busy/u,
      );

      releaseSecondAttempt();
      const result = await first;
      assert.equal(result.run_count, 2);
      assert.equal(
        result.loop_lock_path,
        join(lakeRoot, "stewards", "steward-loop.lock"),
      );

      // 첫 인스턴스 종료(락 해제) 후에는 다시 진입 가능해야 한다.
      const after = await runSteward(["--watch", "--max-runs", "1"], {
        ...stubbedFns([]),
        stdout: silentStdoutBuffer().stdout,
        rootDir,
        lakeRoot,
      });
      assert.equal(after.run_count, 1);
    } finally {
      cleanup();
    }
  });

  it("비-JSON watch 모드는 run마다 진행 라인을 출력한다", async () => {
    const io = silentStdoutBuffer();
    await runSteward(["--watch", "--max-runs", "2", "--interval-ms", "0"], {
      ...stubbedFns([]),
      sleepFn: async () => {},
      acquireLoopLockFn: async () => null,
      stdout: io.stdout,
      rootDir: "/repo",
      lakeRoot: "/repo/.triflux/lake",
    });

    assert.match(
      io.output,
      /cto steward run 1 \(dry-run\): collect=ok hygiene=ok/u,
    );
    assert.match(io.output, /cto steward run 2 /u);
    assert.match(io.output, /stopped=max-runs/u);
  });

  it("abort signal은 무한 watch를 우아하게 멈추고 summary를 반환한다", async () => {
    const controller = new AbortController();
    const io = silentStdoutBuffer();
    const result = await runSteward(["--watch", "--interval-ms", "0"], {
      ...stubbedFns([]),
      acquireLoopLockFn: async () => null,
      installSignalHandler: false,
      signal: controller.signal,
      onRun: async (_run, meta) => {
        if (meta.run_count >= 2) controller.abort();
      },
      stdout: io.stdout,
      rootDir: "/repo",
      lakeRoot: "/repo/.triflux/lake",
    });

    assert.equal(result.run_count, 2);
    assert.equal(result.stopped_reason, "signal");
    assert.match(io.output, /stopped=signal/u);
  });

  it("--max-runs가 --watch 없이 오면 stderr 경고 후 단일 실행한다", async () => {
    let warned = "";
    const result = await runSteward(["--max-runs", "4"], {
      ...stubbedFns([]),
      stderr: {
        write: (chunk) => {
          warned += String(chunk);
          return true;
        },
      },
      stdout: silentStdoutBuffer().stdout,
      rootDir: "/repo",
      lakeRoot: "/repo/.triflux/lake",
    });

    assert.match(warned, /--max-runs is ignored without --watch/u);
    assert.equal(result.run_count, 1);
    assert.equal(result.stopped_reason, "single-run");
  });
});
