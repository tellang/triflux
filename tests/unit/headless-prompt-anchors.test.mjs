import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildHeadlessCommand } from "../../hub/team/headless.mjs";

function readGeneratedPrompt(cmd) {
  const fullPath = cmd.match(/(\/[^\s'"]*prompt-[a-f0-9-]+\.txt)/i)?.[1];
  assert.ok(fullPath, `프롬프트 파일 경로를 추출할 수 있어야 함: ${cmd}`);
  return readFileSync(fullPath, "utf8");
}

describe("headless prompt grounding anchors", () => {
  it("cwd가 있으면 handoff 직전에 workspace grounding 블록을 삽입한다", () => {
    const cmd = buildHeadlessCommand("codex", "do work", "/tmp/r.txt", {
      cwd: "/repo/triflux",
    });
    const content = readGeneratedPrompt(cmd);
    const workspace =
      "[workspace] root(절대경로): /repo/triflux. 모든 상대경로는 이 루트 기준. 파일 쓰기/커밋 전 `git rev-parse --show-toplevel` 이 이 root 와 일치하는지 확인하고 불일치 시 중단·보고.";

    assert.ok(
      content.includes(workspace),
      `workspace grounding 누락: ${content}`,
    );
    assert.ok(
      content.indexOf(workspace) < content.indexOf("--- HANDOFF ---"),
      `workspace grounding은 handoff 전에 있어야 함: ${content}`,
    );
  });

  it("cwd가 없으면 workspace grounding 블록을 생략한다", () => {
    const cmd = buildHeadlessCommand("codex", "do work", "/tmp/r.txt");
    const content = readGeneratedPrompt(cmd);

    assert.ok(
      !content.includes("[workspace] root"),
      `cwd 없을 때 grounding 금지: ${content}`,
    );
  });

  it("32KB 초과 prior_context는 truncated=true와 절단 마커를 표시한다", () => {
    const dir = mkdtempSync(join(tmpdir(), "triflux-headless-context-"));
    try {
      const contextFile = join(dir, "large.md");
      writeFileSync(contextFile, "A".repeat(33000), "utf8");
      const cmd = buildHeadlessCommand("codex", "new task", "/tmp/r.txt", {
        handoff: false,
        contextFile,
      });
      const content = readGeneratedPrompt(cmd);

      assert.ok(
        content.startsWith(
          `<prior_context source="${contextFile}" truncated="true">`,
        ),
        `truncated 속성 누락: ${content.slice(0, 120)}`,
      );
      assert.ok(
        content.includes("[... truncated at 32KB]"),
        `절단 마커 누락: ${content.slice(-200)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
