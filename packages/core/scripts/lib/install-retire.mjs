import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

// 설치본에서 triflux 가 배포하는 디렉터리. ~/.claude 기준.
const ROOTS = ["scripts", "hud", "hub"];
const RETIRED_DIR = ".tfx-retired";
const KEEP_DAYS = 30;
const MANIFEST = "scripts/.tfx-manifest.json";
// 2026-10-08 까지 저장소의 hub, hud, scripts 아래에 있었던 모든 파일 내용의 git blob id 앞 12자리.
// 이 뒤로 빠지는 파일은 매니페스트가 맡는다.
const HISTORY_FILE = new URL("./install-blob-history.json", import.meta.url);
const HUB_CACHE = "cache/tfx-hub";
// 제거된 허브와 계정 브로커만 쓰던 캐시. 지금 코드가 읽는 파일은 넣지 않는다.
const HUB_CACHE_RETIRE = [
  /^state\.db(?:-wal|-shm)?$/,
  /^hub\.log$/,
  /^team-logs$/,
  /^synapse-sessions\.json$/,
  /^team-native-.+\.json$/,
];
// 토큰 사본은 보관하지 않고 바로 지운다.
const HUB_CACHE_DELETE = [
  /^accounts\.json$/,
  /^broker-state\.json$/,
  /^codex-auth-.+\.json$/,
  /^gemini-auth-.+\.json$/,
  /^gemini-accounts-.+\.json$/,
];

export function gitBlobId(content) {
  return createHash("sha1")
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest("hex");
}

function loadHistory() {
  try {
    return new Set(JSON.parse(readFileSync(HISTORY_FILE, "utf8")));
  } catch {
    return new Set();
  }
}

function readManifest(claudeDir) {
  try {
    return (
      JSON.parse(readFileSync(join(claudeDir, MANIFEST), "utf8")).files ?? {}
    );
  } catch {
    return {};
  }
}

// Windows 체크아웃에서 복사된 사본은 CRLF 일 수 있어 LF 로 맞춘 내용도 비교한다.
function isShippedContent(content, rel, history, manifest) {
  const ids = [gitBlobId(content)];
  const text = content.toString("utf8");
  if (text.includes("\r\n"))
    ids.push(gitBlobId(Buffer.from(text.replaceAll("\r\n", "\n"))));
  return ids.some((id) => history.has(id.slice(0, 12)) || manifest[rel] === id);
}

function walkFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === "node_modules" ? [] : walkFiles(path);
    return entry.isFile() ? [path] : [];
  });
}

function moveTo(claudeDir, day, rel) {
  let target = join(claudeDir, RETIRED_DIR, day, rel);
  for (let n = 1; existsSync(target); n++)
    target = join(claudeDir, RETIRED_DIR, day, `${rel}.${n}`);
  mkdirSync(dirname(target), { recursive: true });
  renameSync(join(claudeDir, rel), target);
}

function removeEmptyDirs(dir, keepSelf = true) {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return;
  for (const entry of readdirSync(dir, { withFileTypes: true }))
    if (entry.isDirectory()) removeEmptyDirs(join(dir, entry.name), false);
  if (!keepSelf && readdirSync(dir).length === 0) rmdirSync(dir);
}

function retireHubCache(claudeDir, day, result) {
  const cache = join(claudeDir, HUB_CACHE);
  if (!existsSync(cache)) return;
  for (const name of readdirSync(cache)) {
    const rel = `${HUB_CACHE}/${name}`;
    if (HUB_CACHE_DELETE.some((pattern) => pattern.test(name))) {
      rmSync(join(claudeDir, rel), { recursive: true, force: true });
      result.deleted.push(rel);
    } else if (HUB_CACHE_RETIRE.some((pattern) => pattern.test(name))) {
      moveTo(claudeDir, day, rel);
      result.moved.push(rel);
    }
  }
}

function pruneRetired(claudeDir, now, result) {
  const root = join(claudeDir, RETIRED_DIR);
  if (!existsSync(root)) return;
  const cutoff = now.getTime() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  for (const name of readdirSync(root)) {
    const day = Date.parse(`${name}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name) || !(day < cutoff)) continue;
    rmSync(join(root, name), { recursive: true, force: true });
    result.pruned.push(name);
  }
}

/**
 * 지금 패키지가 배포하지 않는 옛 triflux 설치 파일을 ~/.claude/.tfx-retired/<날짜>/ 로 옮긴다.
 * triflux 가 배포한 내용 그대로인 파일만 옮기고, 고쳤거나 처음 보는 파일은 두며, 30일 지난 보관분은 지운다.
 */
export function retireInstallLeftovers({
  claudeDir,
  keep,
  now = new Date(),
  history = loadHistory(),
}) {
  const result = {
    moved: [],
    failed: [],
    deleted: [],
    pruned: [],
    warnings: [],
  };
  const day = now.toISOString().slice(0, 10);
  const manifest = readManifest(claudeDir);
  for (const root of ROOTS) {
    // 루트가 다른 체크아웃을 가리키는 링크면 옮기기가 그 원본을 지운다.
    if (
      lstatSync(join(claudeDir, root), {
        throwIfNoEntry: false,
      })?.isSymbolicLink()
    )
      continue;
    for (const file of walkFiles(join(claudeDir, root))) {
      const rel = relative(claudeDir, file).replaceAll("\\", "/");
      const name = rel.split("/").pop();
      // 숨김 파일은 setup 상태 파일이고 omc-hud 는 OMC 소유다.
      if (keep.has(rel) || name.startsWith(".") || name.startsWith("omc-hud"))
        continue;
      try {
        if (!isShippedContent(readFileSync(file), rel, history, manifest))
          continue;
        moveTo(claudeDir, day, rel);
        result.moved.push(rel);
      } catch (error) {
        result.failed.push(rel);
        result.warnings.push(
          `${rel}: 옮기기 실패 (${error.code ?? error.message})`,
        );
      }
    }
    removeEmptyDirs(join(claudeDir, root));
  }
  try {
    retireHubCache(claudeDir, day, result);
    pruneRetired(claudeDir, now, result);
  } catch (error) {
    result.warnings.push(
      `옛 허브 캐시 정리 실패: ${error.code ?? error.message}`,
    );
  }
  return result;
}

/**
 * 이번에 배포한 파일의 blob id 를 남겨, 다음 버전에서 빠지는 파일을 같은 기준으로 옮기게 한다.
 * 옮기지 못한 파일(retained)은 이전 근거를 그대로 들고 가 다음 setup 이 다시 시도하게 한다.
 */
export function writeInstallManifest(claudeDir, files, retained = []) {
  const previous = readManifest(claudeDir);
  const entries = {};
  for (const rel of retained) if (previous[rel]) entries[rel] = previous[rel];
  for (const rel of files) {
    try {
      entries[rel] = gitBlobId(readFileSync(join(claudeDir, rel)));
    } catch {
      // 복사되지 않은 파일
    }
  }
  const path = join(claudeDir, MANIFEST);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ files: entries }, null, 2)}\n`);
}
