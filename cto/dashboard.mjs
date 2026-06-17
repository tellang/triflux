import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { resolveLakeRootDir } from "./lake-root.mjs";

const DEFAULT_INTERVAL_MS = 60_000;

function hasFlag(args, flag) {
  return Array.isArray(args) && args.includes(flag);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeAtomic(filePath, body) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  writeFileSync(tmpPath, body, "utf8");
  renameSync(tmpPath, filePath);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatValue(value, fallback = "unknown") {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function shortHead(head) {
  return head ? String(head).slice(0, 12) : "unknown";
}

function countSources(sources) {
  const values = Object.values(sources || {});
  return {
    available: values.filter((source) => source?.available === true).length,
    total: values.length,
  };
}

function normalizeGoal(goal) {
  return {
    id: goal?.id || goal?.goal_id || goal?.name || "goal",
    title: goal?.title || goal?.objective || goal?.summary || null,
    status: goal?.status || goal?.state || goal?.phase || "active",
  };
}

function activeGoals(current) {
  const summaryGoals = Array.isArray(current?.summary?.active_goals)
    ? current.summary.active_goals
    : [];
  if (summaryGoals.length) return summaryGoals.map(normalizeGoal).slice(0, 8);
  const sourceGoals = Object.values(current?.sources || {}).flatMap((source) =>
    Array.isArray(source?.detail?.active_goals)
      ? source.detail.active_goals
      : [],
  );
  return [...summaryGoals, ...sourceGoals].map(normalizeGoal).slice(0, 8);
}

function normalizeShard(shard) {
  return {
    id:
      shard?.id ||
      shard?.shard_id ||
      shard?.shard_name ||
      shard?.name ||
      "shard",
    status: shard?.status || shard?.phase || "active",
    task: shard?.task || shard?.title || shard?.summary || null,
  };
}

function swarmShards(current) {
  const summaryShards = Array.isArray(current?.summary?.swarm_shards)
    ? current.summary.swarm_shards
    : [];
  if (summaryShards.length)
    return summaryShards.map(normalizeShard).slice(0, 8);
  const sourceShards = Array.isArray(
    current?.sources?.tfx_swarm?.detail?.shards,
  )
    ? current.sources.tfx_swarm.detail.shards
    : [];
  return [...summaryShards, ...sourceShards].map(normalizeShard).slice(0, 8);
}

function renderSources(sources) {
  const entries = Object.entries(sources || {});
  if (!entries.length)
    return `<p class="empty">No durable sources recorded.</p>`;
  return `
    <table>
      <thead>
        <tr>
          <th>Source</th>
          <th>Available</th>
          <th>Status</th>
          <th>Collected</th>
        </tr>
      </thead>
      <tbody>
        ${entries
          .map(([id, source]) => {
            const available = source?.available === true;
            return `
              <tr>
                <td>${escapeHtml(id)}</td>
                <td><span class="pill ${available ? "ok" : "missing"}">${available ? "yes" : "no"}</span></td>
                <td>${escapeHtml(formatValue(source?.status, "unknown"))}</td>
                <td>${escapeHtml(formatValue(source?.collected_at, "-"))}</td>
              </tr>
            `;
          })
          .join("")}
      </tbody>
    </table>
  `;
}

function renderGoals(goals) {
  if (!goals.length) return `<p class="empty">No active goals recorded.</p>`;
  return `
    <ul class="items">
      ${goals
        .map(
          (goal) => `
            <li>
              <strong>${escapeHtml(goal.id)}</strong>
              <span>${escapeHtml(goal.title || "untitled")}</span>
              <em>${escapeHtml(goal.status)}</em>
            </li>
          `,
        )
        .join("")}
    </ul>
  `;
}

function renderShards(shards) {
  if (!shards.length) return `<p class="empty">No swarm shards recorded.</p>`;
  return `
    <ul class="items">
      ${shards
        .map(
          (shard) => `
            <li>
              <strong>${escapeHtml(shard.id)}</strong>
              <span>${escapeHtml(shard.task || "no task summary")}</span>
              <em>${escapeHtml(shard.status)}</em>
            </li>
          `,
        )
        .join("")}
    </ul>
  `;
}

function renderLedger(entries) {
  if (!entries.length) return `<p class="empty">No recent ledger events.</p>`;
  return `
    <ol class="ledger">
      ${entries
        .slice(-5)
        .reverse()
        .map(
          (entry) => `
            <li>
              <time>${escapeHtml(formatValue(entry?.ts, "?"))}</time>
              <strong>${escapeHtml(formatValue(entry?.event, "event"))}</strong>
              <span>${escapeHtml(formatValue(entry?.summary, ""))}</span>
            </li>
          `,
        )
        .join("")}
    </ol>
  `;
}

const HYGIENE_METRICS = Object.freeze([
  ["active_tasks", "Active tasks"],
  ["stale_sessions", "Stale sessions"],
  ["orphan_worktrees", "Orphan worktrees"],
  ["superseded_checkpoints", "Superseded checkpoints"],
  ["unknown_owner", "Unknown owners"],
]);

function hygieneCount(hygiene, key) {
  const value = Number(hygiene?.[key] || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function renderHygiene(hygiene) {
  if (!hygiene || typeof hygiene !== "object") return "";
  const actions = Array.isArray(hygiene.actions)
    ? hygiene.actions.slice(0, 5)
    : [];
  const actionCount = hygieneCount(hygiene, "action_count") || actions.length;
  return `
    <section class="panel">
      <h2>Hygiene</h2>
      <table>
        <tbody>
          ${HYGIENE_METRICS.map(
            ([key, label]) => `
              <tr>
                <th>${escapeHtml(label)}</th>
                <td>${hygieneCount(hygiene, key)}</td>
              </tr>
            `,
          ).join("")}
          <tr>
            <th>Actions</th>
            <td>${actionCount}</td>
          </tr>
        </tbody>
      </table>
      ${
        actions.length
          ? `<ul class="items">
              ${actions
                .map(
                  (action) => `
                    <li>
                      <strong>${escapeHtml(formatValue(action?.id || action?.kind, "item"))}</strong>
                      <span>${escapeHtml(formatValue(action?.action || action?.kind, "review"))}</span>
                      <em>${escapeHtml(formatValue(action?.status, "action"))}</em>
                    </li>
                  `,
                )
                .join("")}
            </ul>`
          : `<p class="empty">No hygiene actions reported.</p>`
      }
    </section>
  `;
}

function pageShell(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --fg: #1c2430;
      --muted: #647184;
      --line: #d8dee8;
      --panel: #ffffff;
      --ok: #176b3a;
      --missing: #9b2d20;
      --accent: #245ea8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--fg);
      font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main { max-width: 1120px; margin: 0 auto; padding: 28px 20px 40px; }
    header { margin-bottom: 20px; }
    h1, h2 { margin: 0; line-height: 1.2; letter-spacing: 0; }
    h1 { font-size: 28px; }
    h2 { font-size: 16px; margin-bottom: 12px; }
    .subtle { color: var(--muted); margin: 6px 0 0; }
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 18px 0; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
    .metric { display: block; font-size: 24px; font-weight: 700; }
    .label { display: block; color: var(--muted); font-size: 12px; text-transform: uppercase; }
    .stack { display: grid; gap: 12px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 9px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { color: var(--muted); font-size: 12px; text-transform: uppercase; }
    .pill { display: inline-block; min-width: 40px; border-radius: 999px; padding: 2px 8px; color: #fff; text-align: center; font-size: 12px; }
    .pill.ok { background: var(--ok); }
    .pill.missing { background: var(--missing); }
    .items, .ledger { margin: 0; padding: 0; list-style: none; }
    .items li, .ledger li { display: grid; grid-template-columns: 120px 1fr auto; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--line); }
    .items li:last-child, .ledger li:last-child { border-bottom: 0; }
    .items em { color: var(--muted); font-style: normal; }
    .ledger time { color: var(--muted); }
    .empty { color: var(--muted); margin: 0; }
    .notice { border-left: 4px solid var(--accent); }
    @media (max-width: 760px) {
      main { padding: 20px 12px 28px; }
      .grid { grid-template-columns: 1fr; }
      .items li, .ledger li { grid-template-columns: 1fr; gap: 2px; }
      table { font-size: 13px; }
    }
  </style>
</head>
<body>
  <main>
    ${body}
  </main>
</body>
</html>
`;
}

function renderMissingHtml(generatedAt) {
  return pageShell(
    "Triflux CTO Dashboard",
    `
      <header>
        <h1>Triflux CTO Dashboard</h1>
        <p class="subtle">generated_at: ${escapeHtml(generatedAt)}</p>
      </header>
      <section class="panel notice">
        <h2>No snapshot yet</h2>
        <p class="empty">no snapshot yet - run tfx cto collect</p>
      </section>
    `,
  );
}

function renderCurrentHtml(current) {
  const sources = countSources(current.sources);
  const goals = activeGoals(current);
  const shards = swarmShards(current);
  const repo = current.repo || {};
  const repoState =
    current.summary?.repo_state ||
    `branch ${formatValue(repo.branch)} at ${shortHead(repo.head)} is ${repo.dirty ? "dirty" : "clean"}`;

  return pageShell(
    "Triflux CTO Dashboard",
    `
      <header>
        <h1>Triflux CTO Dashboard</h1>
        <p class="subtle">generated_at: ${escapeHtml(formatValue(current.generated_at, "unknown"))}</p>
      </header>
      <section class="grid" aria-label="CTO dashboard summary">
        <div class="panel">
          <span class="label">Repo State</span>
          <span class="metric">${escapeHtml(repo.dirty ? "dirty" : "clean")}</span>
          <p class="subtle">${escapeHtml(repoState)}</p>
          <p class="subtle">${escapeHtml(formatValue(repo.root, "unknown"))}</p>
        </div>
        <div class="panel">
          <span class="label">Sources</span>
          <span class="metric">${sources.available}/${sources.total}</span>
          <p class="subtle">durable sources available</p>
        </div>
        <div class="panel">
          <span class="label">Active</span>
          <span class="metric">${goals.length} goals / ${shards.length} shards</span>
          <p class="subtle">${escapeHtml(formatValue(repo.branch, "unknown"))}@${escapeHtml(shortHead(repo.head))}</p>
        </div>
      </section>
      <div class="stack">
        <section class="panel">
          <h2>Sources</h2>
          ${renderSources(current.sources)}
        </section>
        <section class="panel">
          <h2>Active Goals</h2>
          ${renderGoals(goals)}
        </section>
        <section class="panel">
          <h2>Swarm Shards</h2>
          ${renderShards(shards)}
        </section>
        ${renderHygiene(current.hygiene || current.summary?.hygiene)}
        <section class="panel">
          <h2>Recent Ledger</h2>
          ${renderLedger(Array.isArray(current.ledger_tail) ? current.ledger_tail : [])}
        </section>
      </div>
    `,
  );
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function renderOnce({ lakeRoot, stdout, stdoutHtml, renders }) {
  const currentPath = join(lakeRoot, "current.json");
  const dashboardPath = join(lakeRoot, "dashboard.html");
  const available = existsSync(currentPath);
  const html = available
    ? renderCurrentHtml(readJson(currentPath))
    : renderMissingHtml(new Date().toISOString());

  writeAtomic(dashboardPath, html);
  if (stdoutHtml) stdout.write(html);
  else stdout.write(`${dashboardPath}\n`);

  return {
    available,
    html,
    path: dashboardPath,
    renders,
  };
}

export async function runDashboard(args = [], opts = {}) {
  const rootDir = opts.rootDir || resolveLakeRootDir(process.cwd());
  const lakeRoot = opts.lakeRoot || join(rootDir, ".triflux", "lake");
  const stdout = opts.stdout || process.stdout;
  const watch = opts.watch === true || hasFlag(args, "--watch");
  const stdoutHtml = opts.stdoutHtml === true || hasFlag(args, "--stdout");
  const intervalMs =
    Number.isFinite(opts.intervalMs) && opts.intervalMs >= 0
      ? opts.intervalMs
      : DEFAULT_INTERVAL_MS;

  if (!watch) {
    return {
      ...(await renderOnce({
        lakeRoot,
        stdout,
        stdoutHtml,
        renders: 1,
      })),
      intervalMs,
      watch: false,
    };
  }

  const maxRenders =
    Number.isFinite(opts.maxRenders) && opts.maxRenders > 0
      ? Math.floor(opts.maxRenders)
      : Infinity;
  let renders = 0;
  let lastRender = null;

  while (renders < maxRenders) {
    renders += 1;
    lastRender = await renderOnce({
      lakeRoot,
      stdout,
      stdoutHtml,
      renders,
    });
    if (typeof opts.onRender === "function") opts.onRender(lastRender);
    if (renders >= maxRenders) break;
    await sleep(intervalMs);
  }

  return {
    ...lastRender,
    intervalMs,
    renders,
    watch: true,
  };
}
