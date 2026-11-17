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
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createResultsIndex,
  extractMarkdownHeadings,
} from "../../hub/team/results-index.mjs";
import {
  DEFAULT_MAX_STDOUT_BYTES,
  sliceUtf8ByBytes,
} from "../../scripts/lib/utf8-slice.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ROUTE_POST = resolve(PROJECT_ROOT, "scripts", "tfx-route-post.mjs");

const tempDirs = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "tfx-utf8-route-post-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("utf8-slice 및 tfx-route-post 무절삭·메타데이터·헤딩 목차 검증", () => {
  it("한글 3바이트와 이모지 4바이트 문자열을 모든 바이트 경계에서 잘라도 U+FFFD가 생기지 않는다", () => {
    assert.equal(DEFAULT_MAX_STDOUT_BYTES, 16 * 1024 * 1024);
    const sample = "A가🚀나🎉다🔥Z";
    const totalBytes = Buffer.byteLength(sample, "utf8");

    for (let limit = 1; limit <= totalBytes + 2; limit += 1) {
      for (const from of ["start", "end"]) {
        const res = sliceUtf8ByBytes(sample, limit, { from });
        assert.ok(
          !res.text.includes("\uFFFD"),
          `limit=${limit} from=${from} 에서 깨진 문자 발생`,
        );
        assert.equal(Buffer.byteLength(res.text, "utf8"), res.outputBytes);
        assert.ok(res.outputBytes <= limit);
        assert.equal(res.rawBytes, totalBytes);
        assert.equal(res.truncated, totalBytes > limit);
      }
    }

    const unlimited = sliceUtf8ByBytes(sample, 0);
    assert.equal(unlimited.text, "");
    assert.equal(unlimited.truncated, true);

    const negativeUnlimited = sliceUtf8ByBytes(sample, -1);
    assert.equal(negativeUnlimited.text, sample);
    assert.equal(negativeUnlimited.truncated, false);
  });

  it("tfx-route-post.mjs는 기본 16MB 아래에서 60KB 한글 출력을 자르지 않고 raw_stdout_bytes와 output_bytes를 기록한다", () => {
    const dir = makeTempDir();
    const home = join(dir, "home");
    mkdirSync(join(home, ".claude", "logs"), { recursive: true });
    const stdoutLog = join(dir, "stdout.log");
    const stderrLog = join(dir, "stderr.log");

    // 약 66KB 멀티바이트 한글 본문 (구 51,200B 기준을 넘지만 16MB 미만)
    const longKorean = `HEAD-MARK\n${"가나다라마바사아자차".repeat(2200)}\nTAIL-MARK`;
    const expectedRawBytes = Buffer.byteLength(longKorean, "utf8");
    assert.ok(expectedRawBytes > 60_000);
    writeFileSync(stdoutLog, longKorean, "utf8");
    writeFileSync(stderrLog, "", "utf8");

    const fullRun = spawnSync(
      process.execPath,
      [
        ROUTE_POST,
        "--agent",
        "executor",
        "--cli",
        "codex",
        "--cli-cmd",
        "codex",
        "--effort",
        "high",
        "--exit-code",
        "0",
        "--elapsed",
        "3",
        "--timeout",
        "1080",
        "--mcp-profile",
        "implement",
        "--stderr-log",
        stderrLog,
        "--stdout-log",
        stdoutLog,
        "--clean-tui",
        "false",
      ],
      {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        env: { ...process.env, HOME: home, USERPROFILE: home },
      },
    );
    assert.equal(fullRun.status, 0, fullRun.stderr);
    assert.match(fullRun.stdout, /HEAD-MARK/);
    assert.match(fullRun.stdout, /TAIL-MARK/);
    assert.doesNotMatch(fullRun.stdout, /truncated to/);

    // 커스텀 --max-bytes 절삭 시 코드포인트 경계 보존 및 바이트 통계 분리 기록 확인
    const cappedRun = spawnSync(
      process.execPath,
      [
        ROUTE_POST,
        "--agent",
        "executor",
        "--cli",
        "codex",
        "--cli-cmd",
        "codex",
        "--effort",
        "high",
        "--exit-code",
        "0",
        "--elapsed",
        "3",
        "--timeout",
        "1080",
        "--mcp-profile",
        "implement",
        "--stderr-log",
        stderrLog,
        "--stdout-log",
        stdoutLog,
        "--max-bytes",
        "1000",
        "--clean-tui",
        "false",
      ],
      {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        env: { ...process.env, HOME: home, USERPROFILE: home },
      },
    );
    assert.equal(cappedRun.status, 0, cappedRun.stderr);
    assert.ok(!cappedRun.stdout.includes("\uFFFD"));
    assert.match(cappedRun.stdout, /TAIL-MARK/);
    assert.match(
      cappedRun.stdout,
      /\[출력 \d+B, 상한 1000B 초과: tail 1000B 유지\]/,
    );

    const statsPath = join(home, ".claude", "logs", "tfx-route-stats.jsonl");
    const statsRows = readFileSync(statsPath, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(statsRows.length, 2);
    assert.equal(statsRows[0].raw_stdout_bytes, expectedRawBytes);
    assert.equal(statsRows[0].output_bytes, expectedRawBytes);
    assert.equal(statsRows[1].raw_stdout_bytes, expectedRawBytes);
    assert.ok(statsRows[1].output_bytes < expectedRawBytes);
    assert.ok(statsRows[1].output_bytes <= 1100);
    assert.ok(statsRows[1].output_bytes > 990);
  });

  it("results-index.mjs는 펜스 코드블록 내부 주석을 제외하고 H1~H3 헤딩과 1-기반 줄 번호를 기록한다", async () => {
    const markdown = [
      "# 첫 번째 제목",
      "본문 설명",
      "```bash",
      "# 이것은 셸 주석이라 목차에 들어가면 안 됨",
      "## 이것도 코드블록 내부",
      "```",
      "## 두 번째 섹션 ##",
      "~~~python",
      "### 틸드 펜스 내부 주석",
      "~~~",
      "### 세 번째 하위 절",
      "#### H4는 수집 대상 아님",
    ].join("\n");

    const extracted = extractMarkdownHeadings(markdown);
    assert.deepEqual(extracted, [
      { level: 1, line: 1, text: "첫 번째 제목" },
      { level: 2, line: 7, text: "두 번째 섹션" },
      { level: 3, line: 11, text: "세 번째 하위 절" },
    ]);

    const dir = makeTempDir();
    const resultFile = join(dir, "worker-1.txt");
    const indexPath = join(dir, "sess.results.json");
    writeFileSync(resultFile, markdown, "utf8");

    const idx = createResultsIndex(
      indexPath,
      "sess",
      [{ paneName: "w1", cli: "codex", role: "executor", resultFile }],
      () => true,
    );
    idx.workerFinished("w1", { matched: true, exitCode: 0 });
    idx.finish(true);

    const saved = JSON.parse(readFileSync(indexPath, "utf8"));
    assert.deepEqual(saved.workers[0].headings, extracted);
  });
});
