import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sanitizeJevInput } from "../../hub/lib/jev-addon.mjs";
import {
  MCP_SERVER_DOMAIN_TAGS,
  MCP_SERVER_TOOL_CATALOG,
  uniqueStrings,
} from "./mcp-server-catalog.mjs";

const REGISTRY = "https://registry.modelcontextprotocol.io/v0.1/servers";
const TTL_MS = 24 * 60 * 60 * 1000;
const LOCAL_DESCRIPTIONS = {
  context7: "Library documentation and code examples",
  "brave-search": "Web and news search",
  exa: "Semantic web and code search",
  playwright: "Browser automation, screenshots and end-to-end testing",
  "sequential-thinking": "Structured reasoning and planning",
};

// 인증 쿼리와 헤더는 보관하지 않는다. URL 비교에는 되돌릴 수 없는 식별값만 쓴다.
export function mcpEndpointId(value) {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol)) return null;
    return createHash("sha256")
      .update(`${url.origin}${url.pathname.replace(/\/$/, "")}`)
      .digest("hex");
  } catch {
    return null;
  }
}

export function mcpCatalogPath({
  env = process.env,
  home = env.HOME || homedir(),
  cacheFile,
} = {}) {
  return (
    cacheFile ||
    join(
      env.XDG_CACHE_HOME || join(home, ".cache"),
      "triflux",
      "mcp-catalog.json",
    )
  );
}

function localEntries(options) {
  const registryFile =
    options.registryFile ||
    (options.env || process.env).TFX_MCP_REGISTRY_PATH ||
    fileURLToPath(new URL("../../config/mcp-registry.json", import.meta.url));
  let servers = {};
  try {
    servers = JSON.parse(readFileSync(registryFile, "utf8")).servers || {};
  } catch {
    /* 내장 후보를 유지한다. */
  }
  return uniqueStrings([
    ...Object.keys(MCP_SERVER_TOOL_CATALOG),
    ...Object.keys(servers),
  ]).map((name) => {
    const entry = servers[name] || {};
    const packages = (Array.isArray(entry.args) ? entry.args : [])
      .filter(
        (arg) =>
          typeof arg === "string" && arg.startsWith("@") && !arg.includes(" "),
      )
      .map((arg) => `npm:${arg.replace(/@[^/@]+$/, "")}`);
    return {
      id: `local:${name}`,
      sourceId: "local",
      serverId: name,
      name,
      description: sanitizeJevInput(
        entry.description ||
          LOCAL_DESCRIPTIONS[name] ||
          "Configured local MCP server metadata",
      ),
      version: "local",
      source: {
        id: "local",
        url: servers[name]
          ? pathToFileURL(registryFile).href
          : new URL("./mcp-server-catalog.mjs", import.meta.url).href,
      },
      collectedAt: null,
      transports: entry.transport ? [entry.transport] : [],
      requirements: uniqueStrings(Object.keys(entry.env || {})),
      targets: Array.isArray(entry.targets)
        ? entry.targets.map((cli) => (cli === "antigravity" ? "agy" : cli))
        : ["claude", "codex", "agy"],
      tags: [...(MCP_SERVER_DOMAIN_TAGS[name] || [])],
      identity: {
        endpoints: [mcpEndpointId(entry.url)].filter(Boolean),
        packages,
      },
    };
  });
}

function normalizeRegistryServer(record, collectedAt) {
  const server = record?.server;
  if (!server || typeof server.name !== "string" || !server.name.trim())
    throw new Error("malformed_registry_server");
  const status =
    record._meta?.["io.modelcontextprotocol.registry/official"]?.status;
  if (status && status !== "active") return null;
  if (
    typeof server.description !== "string" ||
    typeof server.version !== "string" ||
    !server.version
  )
    throw new Error("malformed_registry_server");
  const packages = Array.isArray(server.packages) ? server.packages : [];
  const remotes = Array.isArray(server.remotes) ? server.remotes : [];
  return {
    id: `official:${server.name}`,
    sourceId: "official",
    serverId: server.name,
    name: server.title || server.name,
    description: sanitizeJevInput(server.description).slice(0, 2000),
    version: server.version,
    source: {
      id: "official",
      url: `${REGISTRY}/${encodeURIComponent(server.name)}/versions/${encodeURIComponent(server.version)}`,
    },
    collectedAt,
    transports: uniqueStrings([
      ...packages.map((p) => p.transport?.type || "stdio"),
      ...remotes.map((r) => r.type),
    ]),
    requirements: uniqueStrings(
      packages.flatMap((p) =>
        (p.environmentVariables || []).map((v) => v.name),
      ),
    ),
    targets: ["claude", "codex", "agy"],
    tags: [],
    identity: {
      endpoints: uniqueStrings(
        remotes.map((r) => mcpEndpointId(r.url)).filter(Boolean),
      ),
      packages: uniqueStrings(
        packages
          .filter((p) => p.registryType && p.identifier)
          .map((p) => `${p.registryType}:${p.identifier}`),
      ),
    },
  };
}

function validEntries(entries) {
  return (
    Array.isArray(entries) &&
    entries.every(
      (e) =>
        e?.id === `official:${e?.serverId}` &&
        typeof e.serverId === "string" &&
        e.sourceId === "official" &&
        typeof e.description === "string" &&
        e.source?.url &&
        Array.isArray(e.targets) &&
        Array.isArray(e.transports) &&
        Array.isArray(e.tags) &&
        Array.isArray(e.identity?.endpoints) &&
        Array.isArray(e.identity?.packages),
    )
  );
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function readMcpCatalog(options = {}) {
  const cacheFile = mcpCatalogPath(options);
  const diagnostics = [];
  let cache;
  try {
    cache = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (
      cache.schema !== 1 ||
      !Number.isFinite(Date.parse(cache.collectedAt)) ||
      (cache.watermark !== undefined &&
        !Number.isFinite(Date.parse(cache.watermark))) ||
      !validEntries(cache.entries)
    )
      throw new Error("invalid_cache");
  } catch {
    diagnostics.push(
      existsSync(cacheFile) ? "catalog_invalid" : "catalog_missing",
    );
    cache = null;
  }
  let status = cache ? "fresh" : "missing";
  if (cache && Date.now() - Date.parse(cache.collectedAt) > TTL_MS) {
    status = "stale";
    diagnostics.push("catalog_stale");
  }
  if (existsSync(`${cacheFile}.failure`)) {
    diagnostics.push("catalog_refresh_failed");
    if (cache) status = "stale";
  }
  if (existsSync(`${cacheFile}.progress`)) {
    diagnostics.push("catalog_refresh_in_progress");
    if (cache) status = "stale";
  }
  return {
    cacheFile,
    status,
    collectedAt: cache?.collectedAt || null,
    watermark: cache?.watermark || null,
    entries: [...localEntries(options), ...(cache?.entries || [])],
    diagnostics,
  };
}

export async function refreshMcpCatalog(options = {}) {
  const previous = readMcpCatalog(options);
  if (options.ifStale && previous.status === "fresh") return previous;
  const { cacheFile } = previous;
  const lock = `${cacheFile}.lock`;
  const progressFile = `${cacheFile}.progress`;
  const lockToken = `${process.pid}:${randomUUID()}`;
  let ownsLock = false;
  try {
    mkdirSync(dirname(cacheFile), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2 && !ownsLock; attempt++) {
      try {
        const fd = openSync(lock, "wx", 0o600);
        ownsLock = true;
        try {
          writeFileSync(fd, lockToken);
        } finally {
          closeSync(fd);
        }
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const token = readFileSync(lock, "utf8");
        const owner = Number(token.split(":")[0]);
        let dead = false;
        if (Number.isSafeInteger(owner) && owner > 0) {
          try {
            process.kill(owner, 0);
          } catch (probe) {
            dead = probe.code === "ESRCH";
          }
        }
        if (attempt === 0 && dead && readFileSync(lock, "utf8") === token)
          unlinkSync(lock);
        else
          return {
            ...previous,
            diagnostics: [
              ...previous.diagnostics,
              "catalog_refresh_in_progress",
            ],
          };
      }
    }
    // 진행 상태는 정상 캐시와 분리한다. watermark는 첫 요청 직전 시각으로 고정한다.
    let progress;
    try {
      progress = JSON.parse(readFileSync(progressFile, "utf8"));
      if (
        progress.schema !== 1 ||
        progress.baseCollectedAt !== previous.collectedAt ||
        progress.updatedSince !== previous.watermark ||
        !Number.isFinite(Date.parse(progress.startedAt)) ||
        typeof progress.cursor !== "string" ||
        !Array.isArray(progress.seenCursors) ||
        progress.seenCursors.some((c) => typeof c !== "string" || !c) ||
        (progress.cursor && !progress.seenCursors.includes(progress.cursor)) ||
        !validEntries(progress.entries)
      )
        throw new Error("invalid_progress");
    } catch {
      progress = {
        schema: 1,
        baseCollectedAt: previous.collectedAt,
        updatedSince: previous.watermark,
        startedAt: new Date().toISOString(),
        cursor: "",
        seenCursors: [],
        entries: previous.watermark
          ? previous.entries.filter((e) => e.sourceId === "official")
          : [],
      };
    }
    writeJsonAtomic(progressFile, progress);
    const signal = AbortSignal.timeout(options.timeoutMs || 30000);
    const entries = new Map(progress.entries.map((e) => [e.id, e]));
    const seenCursors = new Set(progress.seenCursors);
    let cursor = progress.cursor;
    for (let page = 0; ; page++) {
      if (page >= 500) throw new Error("pagination_limit");
      signal.throwIfAborted();
      const url = new URL(REGISTRY);
      url.searchParams.set("version", "latest");
      url.searchParams.set("limit", "100");
      if (progress.updatedSince)
        url.searchParams.set("updated_since", progress.updatedSince);
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await (options.fetchImpl || globalThis.fetch)(
        url.toString(),
        { signal },
      );
      if (!response.ok) throw new Error("registry_http_failed");
      const data = await response.json();
      if (!Array.isArray(data.servers))
        throw new Error("malformed_registry_page");
      const next = data.metadata?.nextCursor;
      if (next !== undefined && next !== null && typeof next !== "string")
        throw new Error("malformed_cursor");
      if (next && (seenCursors.has(next) || data.servers.length === 0))
        throw new Error("pagination_loop");
      // 페이지 전체를 확인한 뒤 반영하여 잘못된 페이지의 일부가 저장되지 않게 한다.
      const changes = data.servers.map((record) => ({
        id: `official:${record?.server?.name}`,
        entry: normalizeRegistryServer(record, progress.startedAt),
      }));
      for (const { id, entry } of changes) {
        if (entry) entries.set(id, entry);
        else entries.delete(id);
      }
      if (!next) break;
      seenCursors.add(next);
      cursor = next;
      writeJsonAtomic(progressFile, {
        ...progress,
        cursor,
        seenCursors: [...seenCursors],
        entries: [...entries.values()],
      });
    }
    if (!entries.size && !progress.updatedSince)
      throw new Error("empty_registry");
    writeJsonAtomic(cacheFile, {
      schema: 1,
      collectedAt: new Date().toISOString(),
      watermark: progress.startedAt,
      entries: [...entries.values()],
    });
    unlinkSync(progressFile);
    if (existsSync(`${cacheFile}.failure`)) unlinkSync(`${cacheFile}.failure`);
    return readMcpCatalog(options);
  } catch {
    // 실패 메시지에는 URL이나 인증값이 섞일 수 있으므로 고정 진단만 남긴다.
    try {
      writeFileSync(`${cacheFile}.failure`, "catalog_refresh_failed\n", {
        mode: 0o600,
      });
    } catch {
      /* 캐시 디렉터리 쓰기 실패도 작업을 막지 않는다. */
    }
    const current = readMcpCatalog(options);
    return {
      ...current,
      status: current.collectedAt ? "stale" : "missing",
      diagnostics: uniqueStrings([
        ...current.diagnostics,
        "catalog_refresh_failed",
      ]),
    };
  } finally {
    if (ownsLock) {
      try {
        if (existsSync(lock) && readFileSync(lock, "utf8") === lockToken)
          unlinkSync(lock);
      } catch {
        /* 정리 실패는 기존 작업 실행을 막지 않는다. */
      }
    }
  }
}
