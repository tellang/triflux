import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildRemoteTransferPlan,
  extractExplicitFileTokens,
} from "../lib/remote-spawn-transfer.mjs";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "tfx-remote-spawn-transfer-"));
}

describe("remote-spawn transfer plan", () => {
  it("extractExplicitFileTokens는 명시적 파일 토큰만 추출한다", () => {
    const source = [
      "Read [PRD](.omx/plans/prd.md) and `docs/spec.md`.",
      "Also open \"./notes.txt\" and 'http://example.com'.",
    ].join("\n");

    const tokens = extractExplicitFileTokens(source);

    assert.deepEqual(
      tokens.sort(),
      ["./notes.txt", ".omx/plans/prd.md", "docs/spec.md"].sort(),
    );
  });

  it("handoff + 참조 파일 전송 계획과 프롬프트 재작성", () => {
    const root = makeTempDir();
    try {
      mkdirSync(join(root, "docs"), { recursive: true });
      writeFileSync(join(root, "prd.md"), "prd body", "utf8");
      writeFileSync(join(root, "docs", "spec.md"), "spec body", "utf8");
      writeFileSync(
        join(root, "handoff.md"),
        [
          'Open "./prd.md" before anything else.',
          "Then inspect `docs/spec.md` and [again](docs/spec.md).",
        ].join("\n"),
        "utf8",
      );

      const plan = buildRemoteTransferPlan({
        cwd: root,
        handoffPath: "handoff.md",
        maxBytes: 1024 * 1024,
        remoteStageRoot: "/remote/stage/abc123",
        userPrompt: "continue with execution",
      });

      assert.equal(plan.transfers.length, 3);
      assert.equal(plan.transfers[0].type, "handoff");
      assert.equal(plan.transfers[1].type, "reference");
      assert.equal(plan.transfers[2].type, "reference");

      assert.match(
        plan.prompt,
        /Staged handoff file: \/remote\/stage\/abc123\/handoff\/handoff\.md/,
      );
      assert.match(plan.prompt, /\/remote\/stage\/abc123\/refs\/\d{2}-prd\.md/);
      assert.match(
        plan.prompt,
        /\/remote\/stage\/abc123\/refs\/\d{2}-spec\.md/,
      );
      assert.equal(plan.prompt.includes("./prd.md"), false);
      assert.equal(plan.prompt.includes("docs/spec.md"), false);
      assert.match(plan.prompt, /---\n\ncontinue with execution$/);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("누락된 참조 파일은 SSH 전 로컬에서 실패한다", () => {
    const root = makeTempDir();
    try {
      writeFileSync(join(root, "handoff.md"), "Read `./missing.md`", "utf8");
      assert.throws(
        () =>
          buildRemoteTransferPlan({
            cwd: root,
            handoffPath: "handoff.md",
            maxBytes: 1024 * 1024,
            remoteStageRoot: "/remote/stage/abc123",
          }),
        /referenced file not found:/,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("MAX_HANDOFF_BYTES 제한을 handoff와 참조 파일 모두에 적용한다", () => {
    const root = makeTempDir();
    try {
      writeFileSync(join(root, "big-ref.txt"), "x".repeat(32), "utf8");
      writeFileSync(join(root, "handoff.md"), "Open ./big-ref.txt", "utf8");

      assert.throws(
        () =>
          buildRemoteTransferPlan({
            cwd: root,
            handoffPath: "handoff.md",
            maxBytes: 16,
            remoteStageRoot: "/remote/stage/abc123",
          }),
        /referenced file too large:/,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("handoff가 없으면 기존 prompt 전달 동작을 유지한다", () => {
    const plan = buildRemoteTransferPlan({
      handoffPath: null,
      maxBytes: 1024,
      remoteStageRoot: "/remote/stage/abc123",
      userPrompt: "only prompt",
    });

    assert.equal(plan.prompt, "only prompt");
    assert.deepEqual(plan.transfers, []);
    assert.equal(plan.stagedHandoffPath, null);
  });
});
