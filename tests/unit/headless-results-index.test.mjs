import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const originalPsmuxBin = process.env.PSMUX_BIN;
process.env.PSMUX_BIN = "/usr/bin/false";

const {
  buildHeadlessCommand,
  headlessResultsIndexPath,
  prepareHeadlessWorkerModel,
  runHeadless,
} = await import("../../hub/team/headless.mjs?results-index-test");

const written = [];
after(() => {
  for (const path of written) rmSync(path, { force: true });
  if (originalPsmuxBin === undefined) delete process.env.PSMUX_BIN;
  else process.env.PSMUX_BIN = originalPsmuxBin;
});

const readIndex = (path) => JSON.parse(readFileSync(path, "utf8"));
const twoWorkers = [
  { cli: "codex", prompt: "a" },
  { cli: "codex", prompt: "b" },
];

function indexFor(sessionName) {
  const path = headlessResultsIndexPath(sessionName);
  written.push(path);
  return path;
}

function runWith(sessionName, awaitAll, workerFiles = []) {
  return runHeadless(sessionName, twoWorkers, {
    _deps: {
      dispatchProgressive(name, assignments, opts) {
        opts.sessionOwnership.acquire(name);
        opts.safeProgress({ type: "session_created", sessionName: name });
        return assignments.map((_, i) => {
          const paneName = `worker-${i + 1}`;
          opts.safeProgress({ type: "dispatched", paneName, cli: "codex" });
          return {
            paneName,
            cli: "codex",
            resultFile: "",
            cwd: process.cwd(),
            ...workerFiles[i],
          };
        });
      },
      awaitAll,
      killPsmuxSession() {},
    },
  });
}

describe("headless 결과 색인", () => {
  it("워커 완료마다 갱신하고 세션이 끝나면 completed 로 표시한다", async () => {
    const sessionName = `results-index-${process.pid}`;
    const indexPath = indexFor(sessionName);
    let midRun;

    const result = await runWith(
      sessionName,
      (_name, dispatches, _timeout, safeProgress) => {
        safeProgress({
          type: "completed",
          paneName: "worker-1",
          matched: true,
          exitCode: 0,
        });
        midRun = readIndex(indexPath);
        safeProgress({
          type: "completed",
          paneName: "worker-2",
          matched: true,
          exitCode: 2,
        });
        return dispatches.map((d) => ({
          d,
          completion: { matched: true, exitCode: 0 },
          output: "",
        }));
      },
    );

    assert.equal(result.resultsIndexPath, indexPath);
    assert.equal(midRun.completed, false);
    assert.equal(midRun.finishedAt, null);
    assert.deepEqual(
      midRun.workers.map((w) => w.status),
      ["completed", "running"],
    );

    const final = readIndex(indexPath);
    assert.equal(final.version, 1);
    assert.equal(final.completed, true);
    assert.ok(final.finishedAt);
    assert.deepEqual(
      final.workers.map((w) => [w.paneName, w.status, w.exitCode]),
      [
        ["worker-1", "completed", 0],
        ["worker-2", "failed", 2],
      ],
    );
  });

  it("예외로 끝나면 completed=false 이고 끝나지 못한 워커는 failed 로 확정한다", async () => {
    const sessionName = `results-index-error-${process.pid}`;
    const indexPath = indexFor(sessionName);

    await assert.rejects(
      runWith(sessionName, (_name, _dispatches, _timeout, safeProgress) => {
        safeProgress({
          type: "completed",
          paneName: "worker-1",
          matched: true,
          exitCode: 0,
        });
        throw new Error("await failed");
      }),
      /await failed/u,
    );

    const final = readIndex(indexPath);
    assert.equal(final.completed, false);
    assert.ok(final.finishedAt);
    assert.deepEqual(
      final.workers.map((w) => w.status),
      ["completed", "failed"],
    );
  });

  it("세션을 소유하지 못하면 같은 이름의 색인을 쓰지 않는다", async () => {
    const sessionName = `results-index-foreign-${process.pid}`;
    await assert.rejects(
      runHeadless(sessionName, [{ cli: "codex", prompt: "a" }], {
        _deps: {
          createPsmuxSession() {
            throw new Error("duplicate session");
          },
        },
      }),
      /duplicate session/u,
    );
    assert.equal(existsSync(indexFor(sessionName)), false);
  });
});

it("모델과 MCP sidecar는 완료 수집 시 존재하는 경로만 최종 색인에 보존한다", async () => {
  const sessionName = `results-model-${process.pid}`;
  const indexPath = indexFor(sessionName);
  const files = [1, 2].map((i) => ({
    workerModelFile: `${indexPath}.worker-${i}.model.json`,
    workerMcpFile: `${indexPath}.worker-${i}.mcp.json`,
  }));
  written.push(...files.flatMap((worker) => Object.values(worker)));
  for (const present of [false, true]) {
    const result = await runWith(
      sessionName,
      (_name, dispatches, _timeout, safeProgress) => {
        const running = readIndex(indexPath);
        assert.ok(
          running.workers.every(
            (worker) =>
              worker.workerModelFile === null && worker.workerMcpFile === null,
          ),
        );
        for (const d of dispatches) {
          safeProgress({
            type: "completed",
            paneName: d.paneName,
            matched: true,
            exitCode: d.paneName === "worker-1" ? 0 : 2,
          });
        }
        if (present) {
          for (const file of [files[0].workerModelFile, files[1].workerMcpFile])
            writeFileSync(
              file,
              JSON.stringify({ token: "FAKE_SIDECAR_SECRET" }),
            );
        }
        return dispatches.map((d) => ({
          d,
          completion: {
            matched: true,
            exitCode: d.paneName === "worker-1" ? 0 : 2,
          },
          output: "",
        }));
      },
      files,
    );
    const final = readIndex(indexPath);
    for (const worker of [...result.results, ...final.workers]) {
      assert.equal(
        worker.workerModelFile,
        present && worker.paneName === "worker-1"
          ? files[0].workerModelFile
          : null,
      );
      assert.equal(
        worker.workerMcpFile,
        present && worker.paneName === "worker-2"
          ? files[1].workerMcpFile
          : null,
      );
    }
    assert.equal(final.completed, true);
    assert.deepEqual(
      final.workers.map((worker) => worker.status),
      ["completed", "failed"],
    );
    assert.doesNotMatch(readFileSync(indexPath, "utf8"), /FAKE_SIDECAR_SECRET/);
  }
});

it("Claude direct의 선택값과 실행 argv를 sidecar에 기록하고 최종 색인에서 찾을 수 있다", {
  skip: process.platform === "win32",
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tfx-index-claude-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = join(dir, "claude");
  writeFileSync(
    cli,
    `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify(process.argv.slice(2))));\n`,
  );
  chmodSync(cli, 0o755);
  const sessionName = `results-claude-${process.pid}`;
  const indexPath = indexFor(sessionName);
  const resultFile = join(dir, "result.txt");
  const assignment = {
    cli: "claude",
    prompt: "원 작업",
    model: "fixture-model",
    effort: "high",
  };
  const workerModel = await prepareHeadlessWorkerModel(assignment, {
    env: { ...process.env, TFX_JEV: "off" },
  });
  const result = await runHeadless(sessionName, [assignment], {
    nativeBridge: false,
    _deps: {
      dispatchProgressive(name, _assignments, opts) {
        opts.sessionOwnership.acquire(name);
        opts.safeProgress({ type: "session_created", sessionName: name });
        const command = buildHeadlessCommand(
          "claude",
          assignment.prompt,
          resultFile,
          { workerModel, handoff: false },
        );
        opts.safeProgress({
          type: "dispatched",
          paneName: "worker-1",
          cli: "claude",
        });
        return [
          {
            paneName: "worker-1",
            cli: "claude",
            command,
            resultFile,
            workerModelFile: `${resultFile}.model.json`,
            workerMcpFile: `${resultFile}.mcp.json`,
            cwd: process.cwd(),
          },
        ];
      },
      awaitAll(_name, dispatches, _timeout, safeProgress) {
        return dispatches.map((d) => {
          execFileSync("/bin/sh", ["-c", d.command], {
            env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
          });
          safeProgress({
            type: "completed",
            paneName: d.paneName,
            matched: true,
            exitCode: 0,
          });
          return {
            d,
            completion: { matched: true, exitCode: 0 },
            output: readFileSync(resultFile, "utf8"),
          };
        });
      },
    },
  });
  const metadata = JSON.parse(readFileSync(`${resultFile}.model.json`, "utf8"));
  assert.equal(metadata.model, "fixture-model");
  assert.equal(metadata.effort, "high");
  assert.equal(metadata.source, "explicit");
  assert.equal(metadata.appliedTo, "launch_arguments");
  assert.equal(metadata.runtimeConfirmed, false);
  assert.deepEqual(metadata.launch, {
    cli: "claude",
    profile: null,
    model: "fixture-model",
    effort: "high",
    argv: [
      "--print",
      "--output-format",
      "text",
      "--model",
      "fixture-model",
      "--effort",
      "high",
    ],
  });
  assert.deepEqual(
    metadata.launch.argv,
    JSON.parse(readFileSync(resultFile, "utf8")),
  );
  assert.equal(result.results[0].workerModelFile, `${resultFile}.model.json`);
  const final = readIndex(indexPath);
  assert.equal(final.workers[0].workerModelFile, `${resultFile}.model.json`);
  assert.equal(final.workers[0].workerMcpFile, null);
  assert.doesNotMatch(
    readFileSync(indexPath, "utf8"),
    /fixture-model|launch_arguments/,
  );
});
