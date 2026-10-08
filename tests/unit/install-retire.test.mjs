import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import {
  gitBlobId,
  retireInstallLeftovers,
  writeInstallManifest,
} from "../../scripts/lib/install-retire.mjs";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function claudeDir() {
  const dir = mkdtempSync(join(tmpdir(), "tfx-retire-"));
  dirs.push(dir);
  return dir;
}

function put(root, rel, content) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

const SHIPPED = "// shipped by triflux\n";
const history = new Set([gitBlobId(Buffer.from(SHIPPED)).slice(0, 12)]);
const now = new Date("2026-10-08T00:00:00Z");
const retired = (root, rel) => join(root, ".tfx-retired/2026-10-08", rel);

test("배포한 내용 그대로인 옛 파일만 옮기고 사용자 파일과 현재 배포 파일은 둔다", () => {
  const root = claudeDir();
  put(root, "scripts/hub/server.mjs", SHIPPED);
  put(root, "scripts/tfx-route.sh.bak-1", SHIPPED.replaceAll("\n", "\r\n"));
  put(root, "hud/providers/cto.mjs", "// 사용자가 고친 사본\n");
  put(root, "scripts/gen-capabilities.py", "print(1)\n");
  put(root, "hud/omc-hud.mjs", SHIPPED);
  put(root, "scripts/.tfx-pkg-root", SHIPPED);
  put(root, "scripts/tfx-route.sh", SHIPPED);
  const result = retireInstallLeftovers({
    claudeDir: root,
    keep: new Set(["scripts/tfx-route.sh"]),
    now,
    history,
  });
  assert.deepEqual(result.moved.sort(), [
    "scripts/hub/server.mjs",
    "scripts/tfx-route.sh.bak-1",
  ]);
  assert.equal(
    readFileSync(retired(root, "scripts/hub/server.mjs"), "utf8"),
    SHIPPED,
  );
  assert.equal(existsSync(join(root, "scripts/hub")), false);
  for (const rel of [
    "hud/providers/cto.mjs",
    "scripts/gen-capabilities.py",
    "hud/omc-hud.mjs",
    "scripts/.tfx-pkg-root",
    "scripts/tfx-route.sh",
  ])
    assert.equal(existsSync(join(root, rel)), true, rel);
});

test("매니페스트에 있던 파일은 다음 버전에서 빠지면 같은 기준으로 옮긴다", () => {
  const root = claudeDir();
  put(root, "scripts/lib/new-helper.mjs", "// 이력 목록에 없는 새 파일\n");
  writeInstallManifest(root, ["scripts/lib/new-helper.mjs"]);
  const result = retireInstallLeftovers({
    claudeDir: root,
    keep: new Set(),
    now,
    history: new Set(),
  });
  assert.deepEqual(result.moved, ["scripts/lib/new-helper.mjs"]);
});

test("허브 캐시는 허브 전용 파일을 옮기고 인증 사본은 지우며 지금 쓰는 파일은 둔다", () => {
  const root = claudeDir();
  for (const name of [
    "state.db",
    "hub.log",
    "synapse-sessions.json",
    "accounts.json",
    "codex-auth-a.json",
    "gemini-accounts-b.json",
    "context-monitor.json",
    "team-state-s1.json",
    "logs/x.log",
  ])
    put(root, `cache/tfx-hub/${name}`, "{}");
  const result = retireInstallLeftovers({
    claudeDir: root,
    keep: new Set(),
    now,
    history,
  });
  assert.deepEqual(result.moved.sort(), [
    "cache/tfx-hub/hub.log",
    "cache/tfx-hub/state.db",
    "cache/tfx-hub/synapse-sessions.json",
  ]);
  assert.deepEqual(result.deleted.sort(), [
    "cache/tfx-hub/accounts.json",
    "cache/tfx-hub/codex-auth-a.json",
    "cache/tfx-hub/gemini-accounts-b.json",
  ]);
  assert.equal(
    existsSync(retired(root, "cache/tfx-hub/codex-auth-a.json")),
    false,
  );
  for (const name of [
    "context-monitor.json",
    "team-state-s1.json",
    "logs/x.log",
  ])
    assert.equal(existsSync(join(root, "cache/tfx-hub", name)), true, name);
});

test("30일 지난 보관분만 지운다", () => {
  const root = claudeDir();
  put(root, ".tfx-retired/2026-09-01/scripts/a.mjs", SHIPPED);
  put(root, ".tfx-retired/2026-09-20/scripts/b.mjs", SHIPPED);
  const result = retireInstallLeftovers({
    claudeDir: root,
    keep: new Set(),
    now,
    history,
  });
  assert.deepEqual(result.pruned, ["2026-09-01"]);
  assert.equal(existsSync(join(root, ".tfx-retired/2026-09-20")), true);
});

test("루트가 다른 디렉터리를 가리키는 링크면 그 안은 옮기지 않는다", () => {
  const root = claudeDir();
  const checkout = claudeDir();
  put(checkout, "old-helper.mjs", SHIPPED);
  symlinkSync(checkout, join(root, "scripts"));
  const result = retireInstallLeftovers({
    claudeDir: root,
    keep: new Set(),
    now,
    history,
  });
  assert.deepEqual(result.moved, []);
  assert.equal(existsSync(join(checkout, "old-helper.mjs")), true);
});

test("옮기지 못한 파일은 매니페스트 근거를 유지해 다음 실행에서 옮긴다", () => {
  const root = claudeDir();
  const content = "// 이력 목록에 없는 옛 파일\n";
  put(root, "scripts/lib/old.mjs", content);
  writeInstallManifest(root, ["scripts/lib/old.mjs"]);
  // 보관 경로를 디렉터리가 아닌 파일로 막아 첫 이동을 실패시킨다.
  put(root, ".tfx-retired/2026-10-08", "blocked");
  const first = retireInstallLeftovers({
    claudeDir: root,
    keep: new Set(),
    now,
    history: new Set(),
  });
  assert.deepEqual(first.failed, ["scripts/lib/old.mjs"]);
  writeInstallManifest(root, [], first.failed);
  rmSync(join(root, ".tfx-retired/2026-10-08"));
  const second = retireInstallLeftovers({
    claudeDir: root,
    keep: new Set(),
    now,
    history: new Set(),
  });
  assert.deepEqual(second.moved, ["scripts/lib/old.mjs"]);
});
