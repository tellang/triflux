import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
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
  // 깨진 링크도 있는 것으로 본다.
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  symlinkSync("missing", join(home, ".local", "bin", "tmuxrooms"));
  assert.equal(
    await offerTmrInstall({
      ...base,
      env: { PATH: "" },
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

test("묻는 사이 생긴 tmuxrooms 는 덮지 않고, 링크를 못 만들어도 설치본을 남긴다", async () => {
  const zip = Buffer.from("zip-bytes");
  const sha = createHash("sha256").update(zip).digest("hex");
  const options = {
    release: { ...TMR_RELEASE, sha256: sha },
    fetchFn: fakeFetch({ zip, sums: `${sha}  ${TMR_RELEASE.asset}\n` }),
    run: () => {},
  };
  const home = makeHome();
  const bin = join(home, ".local", "bin");
  await assert.rejects(
    installTmr({
      ...options,
      home,
      extract: (zipPath, out) => {
        fakeExtract(zipPath, out);
        mkdirSync(bin, { recursive: true });
        writeFileSync(join(bin, "tmuxrooms"), "user");
      },
    }),
    { code: "EEXIST" },
  );
  assert.equal(readFileSync(join(bin, "tmuxrooms"), "utf8"), "user");

  // 링크를 못 만들어도 받은 파일과 사용자 파일을 지우지 않는다.
  const other = makeHome();
  const result = await installTmr({
    ...options,
    home: other,
    extract: fakeExtract,
    symlink: () => {
      throw Object.assign(new Error("no space"), { code: "ENOSPC" });
    },
  });
  assert.equal(result.linked, false);
  assert.equal(existsSync(result.target), true);
});

test("읽을 수 없는 PATH 항목이 있어도 동의 단계가 멈추지 않는다", {
  skip: process.getuid?.() === 0,
}, async () => {
  const home = makeHome();
  const locked = join(home, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  try {
    const result = await offerTmrInstall({
      home,
      env: { PATH: locked },
      platform: "darwin",
      arch: "arm64",
      interactive: false,
    });
    assert.equal(result, "deferred");
  } finally {
    chmodSync(locked, 0o755);
  }
});
