import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
export const DEFAULT_MANIFEST_PATH = join(
  ROOT,
  "scripts",
  "release",
  "version-manifest.json",
);

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i++;
  }
  return args;
}

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function getValueAtPath(obj, pathSegments) {
  return pathSegments.reduce((acc, segment) => {
    if (acc === undefined || acc === null) return undefined;
    return acc[segment];
  }, obj);
}

export function setValueAtPath(obj, pathSegments, value) {
  if (!pathSegments.length) {
    throw new Error("pathSegments must not be empty");
  }
  let cursor = obj;
  for (let i = 0; i < pathSegments.length - 1; i++) {
    const segment = pathSegments[i];
    const nextSegment = pathSegments[i + 1];
    if (
      cursor[segment] === undefined ||
      cursor[segment] === null ||
      typeof cursor[segment] !== "object"
    ) {
      cursor[segment] = typeof nextSegment === "number" ? [] : {};
    }
    cursor = cursor[segment];
  }
  cursor[pathSegments.at(-1)] = value;
}

export function formatPathSegments(pathSegments) {
  return pathSegments
    .map((segment) =>
      typeof segment === "number"
        ? `[${segment}]`
        : segment === ""
          ? '[""]'
          : `.${segment}`,
    )
    .join("")
    .replace(/^\./, "");
}

export function isSemver(value) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(value || "").trim());
}

export function loadVersionManifest({
  rootDir = ROOT,
  manifestPath = join(rootDir, "scripts", "release", "version-manifest.json"),
} = {}) {
  const manifest = readJson(manifestPath);
  if (!manifest.canonicalFile || !Array.isArray(manifest.targets)) {
    throw new Error(`Invalid version manifest: ${manifestPath}`);
  }
  return manifest;
}

export function getCanonicalVersion({
  rootDir = ROOT,
  manifest = loadVersionManifest({ rootDir }),
} = {}) {
  const canonicalPath = join(rootDir, manifest.canonicalFile);
  const canonicalJson = readJson(canonicalPath);
  const value = getValueAtPath(
    canonicalJson,
    manifest.canonicalPath || ["version"],
  );
  if (!isSemver(value)) {
    throw new Error(
      `Canonical version is missing or invalid at ${manifest.canonicalFile}`,
    );
  }
  return value;
}

export function collectVersionTargets({
  rootDir = ROOT,
  manifest = loadVersionManifest({ rootDir }),
  expectedVersion = getCanonicalVersion({ rootDir, manifest }),
} = {}) {
  return manifest.targets.flatMap((target) => {
    const absolutePath = join(rootDir, target.file);
    if (!existsSync(absolutePath)) {
      return target.paths.map((pathSegments) => ({
        file: target.file,
        absolutePath,
        path: pathSegments,
        found: undefined,
        expected: expectedVersion,
        inSync: false,
        missing: true,
      }));
    }
    const json = readJson(absolutePath);
    return target.paths.map((pathSegments) => {
      const found = getValueAtPath(json, pathSegments);
      return {
        file: target.file,
        absolutePath,
        path: pathSegments,
        found,
        expected: expectedVersion,
        inSync: found === expectedVersion,
        missing: false,
      };
    });
  });
}

export function syncVersionTargets({
  rootDir = ROOT,
  manifest = loadVersionManifest({ rootDir }),
  expectedVersion = getCanonicalVersion({ rootDir, manifest }),
} = {}) {
  const touched = new Set();
  for (const target of manifest.targets) {
    const absolutePath = join(rootDir, target.file);
    if (!existsSync(absolutePath)) {
      throw new Error(`Cannot sync missing target: ${target.file}`);
    }
    const json = readJson(absolutePath);
    let changed = false;
    for (const pathSegments of target.paths) {
      if (getValueAtPath(json, pathSegments) !== expectedVersion) {
        setValueAtPath(json, pathSegments, expectedVersion);
        changed = true;
      }
    }
    if (changed) {
      writeJson(absolutePath, json);
      touched.add(target.file);
    }
  }
  return [...touched];
}

export function assertVersionSync({
  rootDir = ROOT,
  manifestPath = join(rootDir, "scripts", "release", "version-manifest.json"),
  expectedVersion,
  fix = false,
} = {}) {
  const manifest = loadVersionManifest({ rootDir, manifestPath });
  const rootVersion =
    expectedVersion || getCanonicalVersion({ rootDir, manifest });
  let targets = collectVersionTargets({
    rootDir,
    manifest,
    expectedVersion: rootVersion,
  });
  const mismatches = targets.filter((target) => !target.inSync);
  let fixedFiles = [];

  if (fix && mismatches.length) {
    fixedFiles = syncVersionTargets({
      rootDir,
      manifest,
      expectedVersion: rootVersion,
    });
    targets = collectVersionTargets({
      rootDir,
      manifest,
      expectedVersion: rootVersion,
    });
  }

  return {
    ok: targets.every((target) => target.inSync),
    rootVersion,
    targets,
    mismatches: targets.filter((target) => !target.inSync),
    fixedFiles,
  };
}

export function ensureGitClean({
  rootDir = ROOT,
  execFileSyncFn = execFileSync,
} = {}) {
  const output = execFileSyncFn("git", ["status", "--porcelain"], {
    cwd: rootDir,
    encoding: "utf8",
  }).trim();
  return { clean: output.length === 0, output };
}

export function getPreviousTag({
  rootDir = ROOT,
  execFileSyncFn = execFileSync,
} = {}) {
  try {
    return execFileSyncFn("git", ["describe", "--tags", "--abbrev=0"], {
      cwd: rootDir,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

export function getCommitSummaries({
  rootDir = ROOT,
  previousTag,
  execFileSyncFn = execFileSync,
} = {}) {
  const range = previousTag ? `${previousTag}..HEAD` : "HEAD~10..HEAD";
  try {
    return execFileSyncFn("git", ["log", "--oneline", range], {
      cwd: rootDir,
      encoding: "utf8",
    })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function buildReleaseNotes({
  version,
  rootDir = ROOT,
  execFileSyncFn = execFileSync,
} = {}) {
  const previousTag = getPreviousTag({ rootDir, execFileSyncFn });
  const commits = getCommitSummaries({
    rootDir,
    previousTag,
    execFileSyncFn,
  });
  const heading = previousTag
    ? `Changes since ${previousTag}`
    : "Recent changes (no prior tag found)";
  const lines = commits.length
    ? commits.map((commit) => `- ${commit}`)
    : ["- No commit summary available"];

  return [
    `# Release v${version}`,
    "",
    `## ${heading}`,
    ...lines,
    "",
    "## Install",
    `- npm: \`npm install -g triflux@${version}\``,
    "- Claude Code:",
    "  - `/plugin marketplace add tellang/triflux`",
    "  - `/plugin install triflux@tellang`",
    "",
  ].join("\n");
}

// Windows 에서 `npm`, `gh` 같은 shim 스크립트를 `execFileSync` 로 직접 부르면
// `.cmd` 확장자 미해석으로 ENOENT 가 발생한다. `shell: true` 로 실행하면
// PATHEXT 가 자동 적용되어 모든 플랫폼에서 동일한 호출 시그니처가 유지된다.
const IS_WINDOWS = process.platform === "win32";

function isPipedStdio(stdio) {
  if (stdio === "pipe" || stdio === "overlapped") return true;
  return Array.isArray(stdio)
    ? stdio
        .slice(0, 3)
        .some((entry) => entry === "pipe" || entry === "overlapped")
    : false;
}

export function runCommand(
  command,
  args,
  {
    cwd = ROOT,
    execFileSyncFn = execFileSync,
    stdio = "inherit",
    timeoutMs,
    shell,
    detached,
  } = {},
) {
  const opts = { cwd, stdio };
  if (timeoutMs != null) {
    opts.timeout = timeoutMs;
  }
  if (detached != null) {
    opts.detached = detached;
  }
  if (shell !== undefined) {
    opts.shell = shell;
  } else if (IS_WINDOWS) {
    opts.shell = true;
  }
  if (isPipedStdio(stdio)) {
    opts.encoding = "utf8";
  }

  try {
    return execFileSyncFn(command, args, opts);
  } catch (error) {
    if (timeoutMs != null && error?.code === "ETIMEDOUT") {
      error.message = `Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`;
    }
    throw error;
  }
}
