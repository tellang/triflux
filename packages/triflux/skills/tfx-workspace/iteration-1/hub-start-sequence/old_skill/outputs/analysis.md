# Routing Analysis: `/tfx-hub start`

**Skill source:** `skills/tfx-workspace/skill-snapshot/tfx-hub/SKILL.md`
**Input:** `/tfx-hub start`
**Run mode:** DRY RUN — no commands executed

---

## 1. Command Match vs. Fallthrough

This input **matches a command** — specifically the `start` command.

The skill's input interpretation table explicitly lists:

```
/tfx-hub start  → 커맨드 매칭 → 허브 시작
```

The argument `start` is a recognized command keyword (alongside `stop`, `status`, `--port`). Therefore, the fallthrough path is NOT taken.

---

## 2. Exact Bash Command That Would Be Run

```bash
Bash("node hub/server.mjs", run_in_background=true)
```

This is quoted verbatim from the `### start — 허브 시작` section of the skill definition.

---

## 3. run_in_background Setting

`run_in_background` would be set to **`true`**.

The skill definition explicitly passes `run_in_background=true` as a parameter to the `Bash` call for the `start` command. The hub process is a long-running server and must not block the agent thread.

---

## 4. Port and Endpoint

- **Port:** `27888`
- **MCP endpoint:** `http://127.0.0.1:27888/mcp`
- **Status endpoint:** `http://127.0.0.1:27888/status`

The skill states: "Streamable HTTP MCP 서버를 `http://127.0.0.1:27888/mcp` 에서 시작"

Supporting runtime details:
- SQLite WAL DB: `~/.claude/cache/tfx-hub/state.db`
- PID file: `~/.claude/cache/tfx-hub/hub.pid`
- Port can be overridden via env var `TFX_HUB_PORT`; DB path via `TFX_HUB_DB`

---

## 5. Post-Start Registration Steps

The skill documents a section titled **"각 CLI 등록 방법"** (How to register with each CLI) describing steps to run after the hub starts. These are not executed automatically by the `start` command — they are listed as manual follow-up actions:

```bash
# Codex
codex mcp add tfx-hub --url http://127.0.0.1:27888/mcp

# Gemini (settings.json)
# mcpServers.tfx-hub.url = "http://127.0.0.1:27888/mcp"

# Claude
claude mcp add --transport http tfx-hub http://127.0.0.1:27888/mcp
```

The `start` command itself only launches `node hub/server.mjs` in the background. Registration with individual CLI agents is a separate, post-start step described in the skill but not triggered automatically. The skill does not indicate these registration calls are part of the `start` flow — they are presented as supplementary instructions under their own heading.

---

## Summary Table

| Field                   | Value                                      |
|-------------------------|--------------------------------------------|
| Routing outcome         | Command match (`start`)                    |
| Fallthrough triggered   | No                                         |
| Exact command           | `Bash("node hub/server.mjs", run_in_background=true)` |
| run_in_background       | `true`                                     |
| Hub port                | `27888`                                    |
| MCP endpoint            | `http://127.0.0.1:27888/mcp`              |
| Status endpoint         | `http://127.0.0.1:27888/status`           |
| Post-start registration | Manual — not auto-executed by start command |
