import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// 버전과 체크섬은 이 상수 한 곳에서만 올린다. 받은 파일은 이 sha256 으로만 믿는다.
export const TMR_RELEASE = Object.freeze({
  version: "0.1.0",
  asset: "tmux-rooms-cli-0.1.0-macos-arm64.zip",
  sha256: "342b34768a6f054d6bda6d3a63de37aeae08c5304d4531eecedf9631805a282f",
});
const releaseBase = ({ version }) =>
  `https://github.com/tellang/tmux-rooms/releases/download/v${version}`;

export function tmrSupported(platform = process.platform, arch = process.arch) {
  return platform === "darwin" && arch === "arm64";
}

export function tmrBinDir(home) {
  return join(home, ".local", "bin");
}

export function findTmr({ home, env = process.env }) {
  const dirs = [
    tmrBinDir(home),
    ...String(env.PATH || "").split(delimiter),
  ].filter(Boolean);
  // 깨진 링크도 사용자 것으로 보고 건드리지 않는다. 읽을 수 없는 PATH 항목은 건너뛴다.
  for (const dir of dirs)
    for (const name of ["tmuxrooms", "tmr"]) {
      try {
        if (lstatSync(join(dir, name), { throwIfNoEntry: false }))
          return join(dir, name);
      } catch {}
    }
  return null;
}

async function download(url, fetchFn) {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function extractWithDitto(zipPath, directory) {
  execFileSync("ditto", ["-x", "-k", zipPath, directory], {
    stdio: "ignore",
    timeout: 30_000,
  });
}

/** 체크섬이 맞는 tmuxrooms 를 ~/.local/bin 에 넣고 상대 링크 tmr 을 만든다. */
export async function installTmr({
  home,
  release = TMR_RELEASE,
  fetchFn = fetch,
  extract = extractWithDitto,
  run = execFileSync,
  symlink = symlinkSync,
}) {
  const base = releaseBase(release);
  const zip = await download(`${base}/${release.asset}`, fetchFn);
  if (sha256(zip) !== release.sha256)
    throw new Error("zip 체크섬이 고정값과 다르다");
  const sums = (await download(`${base}/SHA256SUMS`, fetchFn))
    .toString("utf8")
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/));
  const listed = sums.find(([, name]) => name === release.asset)?.[0];
  if (listed !== release.sha256)
    throw new Error("SHA256SUMS 의 값이 고정값과 다르다");

  const work = mkdtempSync(join(tmpdir(), "tfx-tmr-"));
  try {
    const zipPath = join(work, release.asset);
    const out = join(work, "out");
    writeFileSync(zipPath, zip);
    mkdirSync(out);
    extract(zipPath, out);
    const extracted = join(out, "tmuxrooms");
    // zip 에는 실행 파일 하나만 있어야 한다. 다른 구성이면 받은 것을 쓰지 않는다.
    const entries = readdirSync(out);
    if (
      entries.length !== 1 ||
      entries[0] !== "tmuxrooms" ||
      !lstatSync(extracted).isFile()
    )
      throw new Error("zip 구성이 예상과 다르다");

    const binDir = tmrBinDir(home);
    mkdirSync(binDir, { recursive: true, mode: 0o755 });
    const target = join(binDir, "tmuxrooms");
    // 임시 파일은 이번 시도만 쓰는 디렉터리에 둔다. 정리할 때 남의 파일을 지우지 않는다.
    const staging = mkdtempSync(join(binDir, ".tfx-tmr-"));
    try {
      const temporary = join(staging, "tmuxrooms");
      copyFileSync(extracted, temporary);
      chmodSync(temporary, 0o755);
      // 묻는 사이 다른 쪽이 tmuxrooms 를 만들었으면 덮지 않고 실패한다(EEXIST).
      linkSync(temporary, target);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    const link = join(binDir, "tmr");
    // 이미 있는 tmr 은 사용자 것일 수 있어 건드리지 않는다. 링크를 못 만들어도
    // 체크섬이 맞는 tmuxrooms 는 완전한 설치본이라 지우지 않고 안내만 남긴다.
    let linked = false;
    try {
      if (!lstatSync(link, { throwIfNoEntry: false })) {
        symlink("tmuxrooms", link);
        linked = true;
      }
    } catch {}

    let runs = true;
    try {
      run(target, ["--help"], { stdio: "ignore", timeout: 10_000 });
    } catch {
      runs = false;
    }
    return { target, link, linked, runs };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** setup 동의 단계. macOS arm64 에서 tmr 이 없을 때만 묻고, 물을 수 없으면 안내만 남긴다. */
export async function offerTmrInstall({
  interactive,
  ask,
  home,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  install = installTmr,
  log = console.log,
  warn = console.warn,
}) {
  if (!tmrSupported(platform, arch)) return "not-needed";
  if (findTmr({ home, env })) return "present";
  if (!interactive) {
    log("tmr 이 없다. tfx setup 에서 설치를 물을 수 있다.");
    return "deferred";
  }
  if (!(await ask("tmr 을 설치할까요? (tmux 세션 목록 도구, ~/.local/bin)"))) {
    log("tmr 설치를 건너뜀.");
    return "declined";
  }
  try {
    const { target, link, linked, runs } = await install({ home });
    log(`tmr ${TMR_RELEASE.version} 설치: ${target}`);
    if (!linked && !lstatSync(link, { throwIfNoEntry: false }))
      warn(`tmr 링크를 만들지 못했다. 직접 만든다: ln -s tmuxrooms "${link}"`);
    if (!runs) warn(`설치한 ${target} 가 실행되지 않는다.`);
    const binDir = tmrBinDir(home);
    if (
      !String(env.PATH || "")
        .split(delimiter)
        .includes(binDir)
    )
      log(`${binDir} 가 PATH 에 없다. 셸 설정에 추가한다.`);
    return "installed";
  } catch (error) {
    warn(`tmr 설치 실패: ${error?.message || error}`);
    return "failed";
  }
}
