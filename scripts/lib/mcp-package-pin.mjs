import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { loadRegistryOrDefault, pinnedArgs } from "./mcp-guard-engine.mjs";

const require = createRequire(import.meta.url);
const toml = require("@iarna/toml");

// 프로젝트 .mcp.json 은 저장소에 커밋될 수 있어 setup 이 건드리지 않는다.
const REGISTRY_PIN_FILES = [
  [".claude.json", "json", "claude"],
  [".mcp.json", "json", "claude"],
  [".claude/mcp.json", "json", "claude"],
  [".codex/config.toml", "toml", "codex"],
  [".gemini/config/mcp_config.json", "json", "antigravity"],
];

function fileTarget(file) {
  const entry = lstatSync(file, { throwIfNoEntry: false });
  if (!entry) return null;
  const target = entry.isSymbolicLink() ? realpathSync(file) : file;
  if (!statSync(target).isFile())
    throw new Error(`${file}: 일반 파일이 아닙니다`);
  return target;
}

function markFirst(seen, target) {
  const key = realpathSync(target);
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

function backupFile(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let backup = `${file}.tfx-bak-${stamp}`;
  for (let i = 1; existsSync(backup); i++)
    backup = `${file}.tfx-bak-${stamp}-${i}`;
  copyFileSync(file, backup, constants.COPYFILE_EXCL);
  chmodSync(backup, 0o600);
  return backup;
}

function writeAtomic(file, target, output, backups = new Map()) {
  const backup = backups.get(target) ?? backupFile(file);
  backups.set(target, backup);
  const temp = join(
    dirname(target),
    `.tfx-mcp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    writeFileSync(temp, output, {
      encoding: "utf8",
      flag: "wx",
      mode: statSync(target).mode,
    });
    renameSync(temp, target);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* 임시 파일 없음 */
    }
    throw error;
  }
  return backup;
}

function pinJson(original, servers) {
  const data = JSON.parse(original);
  let count = 0;
  for (const [name, server] of servers) {
    const entry = data?.mcpServers?.[name];
    const args = pinnedArgs(entry, server);
    if (!args) continue;
    entry.args = args;
    count++;
  }
  return {
    output: count ? `${JSON.stringify(data, null, 2)}\n` : original,
    count,
  };
}

function tomlSectionBody(text, name) {
  let offset = 0;
  let start = -1;
  for (const line of text.split(/(?<=\n)/)) {
    if (start >= 0 && /^\s*\[/.test(line)) return { start, end: offset };
    const match = line.match(
      /^\s*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\]\s*(?:#.*)?\r?\n?$/,
    );
    offset += line.length;
    if ((match?.[1] ?? match?.[2] ?? match?.[3]) === name) start = offset;
  }
  return start >= 0 ? { start, end: offset } : null;
}

function pinToml(original, servers) {
  const data = toml.parse(original);
  let output = original;
  let count = 0;
  for (const [name, server] of servers) {
    const args = pinnedArgs(data.mcp_servers?.[name], server);
    const section = args && tomlSectionBody(output, name);
    if (!section) continue;
    const body = output.slice(section.start, section.end);
    const next = body.replace(
      /^([ \t]*(?:args|"args"|'args')[ \t]*=[ \t]*)\[[^\]]*\]/m,
      `$1${JSON.stringify(args)}`,
    );
    if (next === body) continue;
    output = output.slice(0, section.start) + next + output.slice(section.end);
    data.mcp_servers[name].args = args;
    count++;
  }
  if (count && !isDeepStrictEqual(toml.parse(output), data))
    throw new Error("TOML 구조 불일치");
  return { output, count };
}

/** 레지스트리 stdio 항목 중 패키지 버전만 다른 것을 레지스트리 고정 버전으로 바꾼다. */
export function pinRegistryMcpPackages({
  home = homedir(),
  registry = loadRegistryOrDefault(),
  backups,
} = {}) {
  const result = {
    ok: true,
    changed: false,
    pinned: 0,
    backups: [],
    warnings: [],
  };
  if (
    process.env.NODE_TEST_CONTEXT &&
    resolve(home) === resolve(userInfo().homedir)
  ) {
    result.skipped = true;
    return result;
  }
  const stdio = Object.entries(registry?.servers ?? {}).filter(
    ([, server]) =>
      typeof server?.command === "string" && Array.isArray(server.args),
  );
  const seen = new Set();
  for (const [relative, kind, client] of REGISTRY_PIN_FILES) {
    const servers = stdio.filter(([, server]) =>
      (server.targets?.length
        ? server.targets
        : ["claude", "codex", "antigravity"]
      ).includes(client),
    );
    if (!servers.length) continue;
    const file = join(home, relative);
    try {
      const target = fileTarget(file);
      if (!target || !markFirst(seen, target)) continue;
      const original = readFileSync(target, "utf8");
      if (!original.trim()) continue;
      const plan =
        kind === "toml"
          ? pinToml(original, servers)
          : pinJson(original, servers);
      if (!plan.count) continue;
      if (
        fileTarget(file) !== target ||
        readFileSync(target, "utf8") !== original
      ) {
        result.warnings.push(`${file}: 검사 후 변경되어 건너뜀`);
        continue;
      }
      result.backups.push(writeAtomic(file, target, plan.output, backups));
      result.pinned += plan.count;
      result.changed = true;
    } catch {
      result.warnings.push(`${file}: MCP 버전 고정 반영 실패, 파일 보존`);
      result.ok = false;
    }
  }
  return result;
}
