# Routing Analysis: `/tfx-hub start`

## Source
Skill definition: `skills/tfx-hub/SKILL.md`

---

## 1. Command Match vs. Fallthrough

**Result: Command match — `start`**

The skill defines an explicit routing table under "입력 해석 규칙":

```
/tfx-hub start  → 커맨드 매칭 → 허브 시작
```

The argument `start` is listed as a command keyword. The fallthrough rule only applies when the argument does NOT match `start`, `stop`, `status`, or `--port`. Therefore `/tfx-hub start` is handled by the `start` command branch, not the free-form fallthrough.

---

## 2. Exact Bash Command

```bash
Bash("node hub/server.mjs", run_in_background=true)
```

Quoted verbatim from the skill's `### start — 허브 시작` section.

---

## 3. `run_in_background`

**Set to `true`.**

The skill explicitly passes `run_in_background=true` in the `start` command call. This is the only command in the skill that uses background execution.

---

## 4. Port and Endpoint

- **Port:** `27888` (default; overridable via environment variable `TFX_HUB_PORT`)
- **MCP endpoint:** `http://127.0.0.1:27888/mcp`
- **Status endpoint:** `http://127.0.0.1:27888/status`

Additional runtime artefacts written on start:
- SQLite WAL DB: `~/.claude/cache/tfx-hub/state.db`
- PID file: `~/.claude/cache/tfx-hub/hub.pid`

---

## 5. Post-Start Registration Steps

The skill describes registering the running hub with each CLI agent under "각 CLI 등록 방법":

```bash
# Codex
codex mcp add tfx-hub --url http://127.0.0.1:27888/mcp

# Gemini (settings.json)
# mcpServers.tfx-hub.url = "http://127.0.0.1:27888/mcp"

# Claude
claude mcp add --transport http tfx-hub http://127.0.0.1:27888/mcp
```

These steps are documented but are listed as per-CLI manual registration steps — the skill does not show them being executed automatically as part of the `start` command block itself. The `start` block contains only the single `Bash("node hub/server.mjs", run_in_background=true)` call.

---

## Summary Table

| Attribute | Value |
|-----------|-------|
| Routing outcome | Command match (`start`) |
| Fallthrough triggered | No |
| Bash command | `Bash("node hub/server.mjs", run_in_background=true)` |
| `run_in_background` | `true` |
| Port | `27888` |
| MCP endpoint | `http://127.0.0.1:27888/mcp` |
| Post-start registration | Documented (manual, per-CLI); not auto-executed by `start` |
