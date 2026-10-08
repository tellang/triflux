import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  installTmr,
  offerTmrInstall,
  TMR_RELEASE,
} from "../../scripts/lib/tmr-install.mjs";

const homes = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "tfx-tmr-"));
  homes.push(home);
  return home;
}

function fakeFetch({ zip, sums }) {
  return async (url) => ({
    ok: true,
    status: 200,
    arrayBuffer: async () =>
      url.endsWith("SHA256SUMS") ? Buffer.from(sums) : zip,
  });
}

const fakeExtract = (_zip, out) =>
  writeFileSync(join(out, "tmuxrooms"), "#!/bin/sh\n");

test("arm64 macOS 가 아니면 아무것도 하지 않는다", async () => {
  let asked = false;
  const result = await offerTmrInstall({
    interactive: true,
    ask: async () => (asked = true),
    home: makeHome(),
    env: { PATH: "" },
    platform: "linux",
    arch: "x64",
  });
  assert.equal(result, "not-needed");
  assert.equal(asked, false);
});

test("비대화형이면 받지 않고, 이미 있으면 묻지 않는다", async () => {
  const home = makeHome();
  const base = { home, platform: "darwin", arch: "arm64" };
  const install = async () => assert.fail("받으면 안 된다");
  assert.equal(
    await offerTmrInstall({
      ...base,
      env: { PATH: "" },
      interactive: false,
      install,
    }),
    "deferred",
  );
  writeFileSync(join(home, "tmr"), "");
  assert.equal(
    await offerTmrInstall({
      ...base,
      env: { PATH: home },
      interactive: true,
      ask: async () => assert.fail("물으면 안 된다"),
      install,
    }),
    "present",
  );
});

test("체크섬이 다르면 설치하지 않는다", async () => {
  const home = makeHome();
  await assert.rejects(
    installTmr({
      home,
      fetchFn: fakeFetch({
        zip: Buffer.from("tampered"),
        sums: `${TMR_RELEASE.sha256}  ${TMR_RELEASE.asset}\n`,
      }),
      extract: fakeExtract,
    }),
    /체크섬/,
  );
  assert.equal(existsSync(join(home, ".local", "bin", "tmuxrooms")), false);
});

test("체크섬이 맞으면 0755 tmuxrooms 와 상대 링크 tmr 을 만든다", async () => {
  const home = makeHome();
  const zip = Buffer.from("zip-bytes");
  const sha = createHash("sha256").update(zip).digest("hex");
  const release = { ...TMR_RELEASE, sha256: sha };
  const result = await installTmr({
    home,
    release,
    fetchFn: fakeFetch({ zip, sums: `${sha}  ${TMR_RELEASE.asset}\n` }),
    extract: fakeExtract,
    run: () => {},
  });
  assert.equal(result.runs, true);
  assert.equal(statSync(result.target).mode & 0o777, 0o755);
  assert.equal(readlinkSync(result.link), "tmuxrooms");
});
