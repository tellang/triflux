/** biome-ignore-all lint/suspicious/noThenProperty: pendingHandoff 스키마의 then은 함수가 아닌 지시 문자열이다. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  leadRoleDir,
  readLeadMarker,
  removeLeadMarker,
  updateLeadMarker,
  writeLeadMarker,
} from "../../hub/lib/lead-marker.mjs";

function withTempEnv(t) {
  const root = mkdtempSync(join(tmpdir(), "tfx-lead-marker-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    env: {
      HOME: root,
      XDG_STATE_HOME: join(root, "state"),
    },
  };
}

describe("lead-marker", () => {
  it("leadRoleDir는 XDG_STATE_HOME과 HOME 순서로 경로를 결정한다", () => {
    assert.equal(
      leadRoleDir({ XDG_STATE_HOME: "/tmp/custom-state", HOME: "/tmp/home" }),
      "/tmp/custom-state/triflux/lead-roles",
    );
    assert.equal(
      leadRoleDir({ HOME: "/tmp/custom-home" }),
      "/tmp/custom-home/.local/state/triflux/lead-roles",
    );
  });

  it("lead와 communication 세션만 기록하고 일반 워커는 기록하지 않는다", (t) => {
    const { env } = withTempEnv(t);
    assert.equal(
      writeLeadMarker(
        {
          session: "worker-1",
          cli: "codex",
          sessionRole: "worker",
          role: "구현 워커",
        },
        { env },
      ),
      null,
    );
    assert.equal(readLeadMarker({ session: "worker-1" }, { env }), null);

    const written = writeLeadMarker(
      {
        session: "triflux-lead",
        paneId: "%12",
        cli: "agy",
        sessionRole: "lead",
        role: "v11 리드",
        name: "11.18 v11 리드",
        cwd: "/tmp/work/triflux",
      },
      { env },
    );
    assert.ok(written);
    assert.equal(written.session, "triflux-lead");
    assert.equal(written.paneId, "%12");
    assert.equal(written.cli, "agy");
    assert.equal(written.sessionRole, "lead");
    assert.equal(written.role, "v11 리드");
    assert.equal(written.name, "11.18 v11 리드");
    assert.equal(written.cwd, resolve("/tmp/work/triflux"));
    assert.equal(written.conversationId, null);
    assert.equal(written.threadId, null);
    assert.equal(written.pendingHandoff, null);
    assert.equal(written.notifiedConversationId, null);
    assert.equal(written.notifiedThreadId, null);
    assert.equal(written.notifiedThreshold, 0);
    assert.equal(typeof written.since, "string");

    if (process.platform !== "win32") {
      const dirMode = statSync(leadRoleDir(env)).mode & 0o777;
      const fileMode =
        statSync(join(leadRoleDir(env), "triflux-lead.json")).mode & 0o777;
      assert.equal(dirMode, 0o700);
      assert.equal(fileMode, 0o600);
    }
  });

  it("readLeadMarker는 paneId, session, conversationId, threadId, cli+cwd 우선순위로 조회한다", (t) => {
    const { env } = withTempEnv(t);
    writeLeadMarker(
      {
        session: "app-lead",
        paneId: "%10",
        cli: "codex",
        sessionRole: "lead",
        role: "코드 리드",
        name: "11.18 코드 리드",
        cwd: "/work/app",
        threadId: "thread-aaa",
      },
      { env },
    );
    writeLeadMarker(
      {
        session: "app-comm",
        paneId: "%11",
        cli: "agy",
        sessionRole: "communication",
        role: "소통 창구",
        name: "11.18 소통 창구",
        cwd: "/work/app",
        conversationId: "conv-bbb",
      },
      { env },
    );

    assert.equal(
      readLeadMarker({ paneId: "%11", session: "app-lead" }, { env })?.session,
      "app-comm",
    );
    assert.equal(
      readLeadMarker({ paneId: "%99", session: "app-lead" }, { env })?.session,
      "app-lead",
    );
    assert.equal(
      readLeadMarker({ conversationId: "conv-bbb" }, { env })?.session,
      "app-comm",
    );
    assert.equal(
      readLeadMarker({ threadId: "thread-aaa" }, { env })?.session,
      "app-lead",
    );
    assert.equal(
      readLeadMarker({ cli: "codex", cwd: "/work/app" }, { env })?.session,
      "app-lead",
    );
    // paneId 나 session 이 주어졌는데 불일치하면 cli+cwd 폴백으로 넘어가지 않는다.
    assert.equal(
      readLeadMarker(
        { paneId: "%99", cli: "codex", cwd: "/work/app" },
        { env },
      ),
      null,
    );
  });

  it("updateLeadMarker와 removeLeadMarker로 상태를 갱신하고 삭제한다", (t) => {
    const { env } = withTempEnv(t);
    writeLeadMarker(
      {
        session: "triflux-lead",
        paneId: "%12",
        cli: "codex",
        sessionRole: "lead",
        role: "리드",
        cwd: "/work/triflux",
      },
      { env },
    );

    const updated = updateLeadMarker(
      { session: "triflux-lead" },
      {
        threadId: "thread-123",
        notifiedThreshold: 60,
        pendingHandoff: { path: "/tmp/h.md", then: "계속", at: "2026-11-18" },
      },
      { env },
    );
    assert.equal(updated.threadId, "thread-123");
    assert.equal(updated.notifiedThreshold, 60);
    assert.deepEqual(updated.pendingHandoff, {
      path: "/tmp/h.md",
      then: "계속",
      at: "2026-11-18",
    });

    assert.equal(removeLeadMarker({ paneId: "%12" }, { env }), true);
    assert.equal(readLeadMarker({ session: "triflux-lead" }, { env }), null);
  });
});
