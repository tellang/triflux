import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { privateTmpDir, privateTmpRoot } from "../../hub/lib/private-tmp.mjs";

const posix = process.platform !== "win32";
const uid = process.getuid?.();

describe("private-tmp", { skip: !posix }, () => {
  let base;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "tfx-private-tmp-test-"));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("uid 루트를 0700 으로 만들고 하위 디렉터리를 돌려준다", () => {
    const dir = privateTmpDir("tfx-headless", { base });
    assert.equal(dir, join(base, `triflux-${uid}`, "tfx-headless"));
    assert.equal(statSync(join(base, `triflux-${uid}`)).mode & 0o777, 0o700);
  });

  it("느슨한 권한의 자기 루트는 0700 으로 좁힌다", () => {
    const root = join(base, `triflux-${uid}`);
    mkdirSync(root);
    chmodSync(root, 0o755);
    privateTmpRoot({ base });
    assert.equal(statSync(root).mode & 0o777, 0o700);
  });

  it("남의 uid 루트와 심볼릭 링크 루트, 링크 하위는 거부한다", () => {
    mkdirSync(join(base, "elsewhere"));
    privateTmpRoot({ base });
    symlinkSync(join(base, "elsewhere"), join(base, `triflux-${uid}`, "sub"));
    assert.throws(() => privateTmpDir("sub", { base }), /unsafe temp dir/);
    rmSync(join(base, `triflux-${uid}`), { recursive: true });
    symlinkSync(join(base, "elsewhere"), join(base, `triflux-${uid}`));
    assert.throws(() => privateTmpRoot({ base }), /unsafe temp dir/);
    mkdirSync(join(base, `triflux-${uid + 1}`));
    assert.throws(() => privateTmpRoot({ base, uid: uid + 1 }), /unsafe/);
  });
});
