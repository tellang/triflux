// hub/team/swarm-planner.mjs — PRD → Swarm execution plan generator
// Parses a PRD markdown document into shards (units of work), each with:
//   - file-lease-map: files the shard is allowed to modify
//   - MCP manifest: MCP servers the shard needs
//   - mergeOrder: topological order for integrating results
//
// PRD format expected:
//   ## Shard: <name>
//   - agent: codex|gemini|claude
//   - files: path/a.mjs, path/b.mjs
//   - mcp: server1, server2
//   - depends: shard-name-1, shard-name-2
//   - critical: true|false
//   - prompt: |
//       multi-line prompt text

import { readFileSync } from "node:fs";
import { selectHostForCapability } from "../lib/ssh-command.mjs";

/** Shard schema defaults */
const SHARD_DEFAULTS = Object.freeze({
  agent: "codex",
  files: [],
  mcp: [],
  depends: [],
  critical: false,
  prompt: "",
  host: "",
});

/**
 * Parse a PRD markdown into shard definitions.
 * @param {string} content — PRD markdown content
 * @returns {Shard[]}
 */
export function parseShards(content) {
  const lines = content.split(/\r?\n/);
  const shards = [];
  let current = null;
  let inPrompt = false;
  let promptLines = [];

  function flushPrompt() {
    if (current && promptLines.length > 0) {
      current.prompt = promptLines.join("\n").trim();
      promptLines = [];
    }
    inPrompt = false;
  }

  function flushShard() {
    flushPrompt();
    if (current) {
      shards.push({ ...SHARD_DEFAULTS, ...current });
      current = null;
    }
  }

  for (const line of lines) {
    // New shard header: ## Shard: <name>
    const shardMatch = line.match(/^##\s+Shard:\s*(.+)$/i);
    if (shardMatch) {
      flushShard();
      current = { name: shardMatch[1].trim() };
      continue;
    }

    // Non-shard heading ends current shard (e.g. ## Notes)
    if (/^##\s+/.test(line) && !line.match(/^##\s+Shard:/i)) {
      flushShard();
      continue;
    }

    if (!current) continue;

    // Prompt block continuation
    if (inPrompt) {
      if (/^- \w+:/i.test(line)) {
        flushPrompt();
        // fall through to field parsing
      } else {
        promptLines.push(line);
        continue;
      }
    }

    // Field parsing: - key: value
    const fieldMatch = line.match(/^-\s+(\w+):\s*(.*)$/i);
    if (!fieldMatch) continue;

    const [, key, rawValue] = fieldMatch;
    const value = rawValue.trim();

    switch (key.toLowerCase()) {
      case "agent":
        current.agent = value.toLowerCase();
        break;
      case "files":
        current.files = value
          .split(/,\s*/)
          .map((f) => f.trim())
          .filter(Boolean);
        break;
      case "mcp":
        current.mcp = value
          .split(/,\s*/)
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "depends":
        current.depends = value
          .split(/,\s*/)
          .map((d) => d.trim())
          .filter(Boolean)
          .filter((d) => !["none", "-", "—", "n/a", "없음"].includes(d.toLowerCase()));
        break;
      case "critical":
        current.critical = /^(true|yes|1)$/i.test(value);
        break;
      case "host":
        current.host = value;
        break;
      case "prompt":
        if (value && !value.startsWith("|")) {
          current.prompt = value;
        } else {
          inPrompt = true;
          promptLines = [];
        }
        break;
      default:
        // store unknown fields as-is
        current[key] = value;
    }
  }

  flushShard();
  return shards;
}

/**
 * Build file-lease-map from shards.
 * Maps each shard name to its allowed files.
 * Detects conflicting file assignments across shards.
 * @param {Shard[]} shards
 * @returns {{ leaseMap: Map<string, string[]>, conflicts: Array<{ file: string, shards: string[] }> }}
 */
export function buildFileLeaseMap(shards) {
  const leaseMap = new Map();
  const fileOwners = new Map(); // file → [shard names]

  for (const shard of shards) {
    leaseMap.set(shard.name, [...shard.files]);
    for (const file of shard.files) {
      const owners = fileOwners.get(file) || [];
      owners.push(shard.name);
      fileOwners.set(file, owners);
    }
  }

  const conflicts = [];
  for (const [file, owners] of fileOwners) {
    if (owners.length > 1) {
      conflicts.push({ file, shards: owners });
    }
  }

  return { leaseMap, conflicts };
}

/**
 * Build MCP manifest from shards.
 * Maps each shard name to its required MCP servers.
 * @param {Shard[]} shards
 * @returns {Map<string, string[]>}
 */
export function buildMcpManifest(shards) {
  const manifest = new Map();
  for (const shard of shards) {
    manifest.set(shard.name, [...shard.mcp]);
  }
  return manifest;
}

/**
 * Compute topological merge order based on shard dependencies.
 * @param {Shard[]} shards
 * @returns {{ order: string[], cycles: string[][] }}
 */
export function computeMergeOrder(shards) {
  const nameSet = new Set(shards.map((s) => s.name));
  const adj = new Map(); // name → [dependents]
  const inDeg = new Map(); // name → number

  for (const shard of shards) {
    adj.set(shard.name, []);
    inDeg.set(shard.name, 0);
  }

  for (const shard of shards) {
    for (const dep of shard.depends) {
      if (!nameSet.has(dep)) continue; // ignore unknown deps
      adj.get(dep).push(shard.name);
      inDeg.set(shard.name, inDeg.get(shard.name) + 1);
    }
  }

  // Kahn's algorithm
  const queue = [];
  for (const [name, deg] of inDeg) {
    if (deg === 0) queue.push(name);
  }

  const order = [];
  while (queue.length > 0) {
    // stable sort: alphabetical among same-level nodes
    queue.sort();
    const node = queue.shift();
    order.push(node);

    for (const next of adj.get(node)) {
      const newDeg = inDeg.get(next) - 1;
      inDeg.set(next, newDeg);
      if (newDeg === 0) queue.push(next);
    }
  }

  // Detect cycles (nodes not in order)
  const cycles = [];
  if (order.length < shards.length) {
    const remaining = shards
      .filter((s) => !order.includes(s.name))
      .map((s) => s.name);
    cycles.push(remaining);
  }

  return { order, cycles };
}

/**
 * Full planning pipeline: parse PRD → build plan.
 * @param {string} prdPath — path to PRD markdown file
 * @param {object} [opts]
 * @param {string} [opts.content] — PRD content (if provided, prdPath is ignored)
 * @returns {SwarmPlan}
 */
export function planSwarm(prdPath, opts = {}) {
  const content = opts.content || readFileSync(prdPath, "utf8");
  const shards = parseShards(content);

  if (shards.length === 0) {
    throw new Error(
      'No shards found in PRD. Expected "## Shard: <name>" sections.',
    );
  }

  const { leaseMap, conflicts } = buildFileLeaseMap(shards);
  const mcpManifest = buildMcpManifest(shards);
  const { order: mergeOrder, cycles } = computeMergeOrder(shards);

  if (cycles.length > 0) {
    throw new Error(`Dependency cycle detected: ${cycles[0].join(" → ")}`);
  }

  // Auto-remote suggestion: PRD에 host 미지정 shard가 있고,
  // hosts.json에 가용 원격 호스트가 있으면 제안 데이터를 생성한다.
  const remoteSuggestion = buildRemoteSuggestion(shards, opts.repoRoot);

  return Object.freeze({
    shards: Object.freeze(shards.map((s) => Object.freeze({ ...s }))),
    leaseMap,
    mcpManifest,
    mergeOrder,
    conflicts,
    criticalShards: shards.filter((s) => s.critical).map((s) => s.name),
    remoteSuggestion,
  });
}

/**
 * PRD shard에 host가 없고 원격 호스트가 가용하면 분배 제안을 생성한다.
 * 실제 AskUserQuestion 호출은 스킬(tfx-swarm)에서 수행. 여기는 데이터만.
 * @param {Shard[]} shards
 * @param {string} [repoRoot]
 * @returns {object|null} 제안 데이터 또는 null (제안 없음)
 */
function buildRemoteSuggestion(shards, repoRoot) {
  const localShards = shards.filter((s) => !s.host);
  if (localShards.length === 0) return null; // 모든 shard에 host 지정됨

  // 각 shard의 agent에 대해 가용 원격 호스트 조회
  const agentTypes = [...new Set(localShards.map((s) => s.agent))];
  const availableHosts = [];

  for (const agent of agentTypes) {
    try {
      const hosts = selectHostForCapability(agent, repoRoot);
      for (const h of hosts) {
        if (!availableHosts.find((ah) => ah.name === h.name)) {
          availableHosts.push(h);
        }
      }
    } catch {
      // hosts.json 없거나 파싱 실패 → 무시
    }
  }

  if (availableHosts.length === 0) return null;

  // 분배 제안: 로컬 shard 중 절반(내림)을 원격에 배치
  const remoteCount = Math.min(
    Math.floor(localShards.length / 2),
    availableHosts.length,
  );
  if (remoteCount === 0) return null;

  // 의존성 없는 shard를 우선 원격 후보로 선택
  const candidates = localShards
    .filter((s) => s.depends.length === 0)
    .concat(localShards.filter((s) => s.depends.length > 0));

  const suggested = [];
  for (let i = 0; i < remoteCount && i < candidates.length; i++) {
    const shard = candidates[i];
    const host = availableHosts[i % availableHosts.length];
    suggested.push({
      shardName: shard.name,
      host: host.name,
      hostDescription: host.config.description,
      specs: host.specs,
    });
  }

  return Object.freeze({
    localCount: localShards.length - remoteCount,
    remoteCount,
    totalShards: shards.length,
    availableHosts: availableHosts.map((h) => ({
      name: h.name,
      description: h.config.description,
      specs: h.specs,
      capabilities: h.config.capabilities,
    })),
    suggested: Object.freeze(suggested),
  });
}
