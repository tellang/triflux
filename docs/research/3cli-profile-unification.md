# 3-CLI Profile Unification Research

> Date: 2026-04-09 | Target: Claude Code, Codex CLI, Gemini CLI

## 1. Config Comparison

| Item | Claude | Codex | Gemini |
|------|--------|-------|--------|
| Config file | ~/.claude/settings.json | ~/.codex/config.toml | ~/.gemini/ |
| Project config | CLAUDE.md | CODEX.md, AGENTS.md | none |
| Model selection | API param, env var | model in config.toml | --model flag |
| Profile system | none (native) | [profiles.name] TOML | none (triflux custom) |
| Approval mode | permission modes | approval_mode | --auto-approve |
| Sandbox | none | sandbox (elevated/workspace) | none |
| MCP | mcpServers | experimental | unsupported |
| Context | 200K default | model_context_window | 1M fixed |
| Effort | CLAUDE_CODE_EFFORT_LEVEL | model_reasoning_effort | none |

## 2. Claude Code Details

- settings.json: env, permissions, hooks, includeCoAuthoredBy
- Effort: CLAUDE_CODE_EFFORT_LEVEL env (low/medium/high/max)
- Permission modes: default, plan, auto, acceptEdits, bypassPermissions
- Models: opus-4-6, sonnet-4-6, haiku-4-5
- No native profile system

## 3. Codex CLI Details

- config.toml: model, approval_mode, model_reasoning_effort, [profiles.*]
- 12 profiles: gpt54 (xhigh/high/low), codex53 (xhigh/high/med/low), spark53 (low/med), mini54 (low/med/high)
- exec mode: codex exec "prompt" -s danger-full-access
- Native profile: --profile name

## 4. Gemini CLI Details

- No native profile. triflux manages: ~/.gemini/triflux-profiles.json
- 5 models: pro31, flash3, pro25, flash25, lite25
- gemini-profiles.mjs handles CRUD
- tfx-route.sh resolve_gemini_profile() converts name to model

## 5. Current Routing Issues

1. Profile mismatch: same intent different syntax (--profile vs --model)
2. 3 locations: config.toml + triflux-profiles.json + nothing
3. Manual fallback: rate limit CLI switching requires hardcoded mapping
4. Effort asymmetry: Codex 4 levels, Claude 4 levels (different names), Gemini none

## 6. Unified Profile Schema

Design: intent-based, CLI-independent, backward-compatible, extensible

```toml
[profiles.flagship]
tier = "flagship", effort = "xhigh"
claude = { model = "claude-opus-4-6" }
codex = { model = "gpt-5.4", effort = "xhigh" }
gemini = { model = "gemini-3.1-pro-preview" }

[profiles.standard]
tier = "standard", effort = "high"
claude = { model = "claude-sonnet-4-6" }
codex = { model = "gpt-5.4", effort = "high" }
gemini = { model = "gemini-2.5-pro" }

[profiles.fast]
tier = "economy", effort = "medium"
claude = { model = "claude-sonnet-4-6" }
codex = { model = "gpt-5.3-codex", effort = "medium" }
gemini = { model = "gemini-3-flash-preview" }

[profiles.economy]
tier = "economy", effort = "low"
claude = { model = "claude-haiku-4-5" }
codex = { model = "gpt-5.3-codex", effort = "low" }
gemini = { model = "gemini-2.5-flash" }

[profiles.micro]
tier = "micro", effort = "low"
claude = { model = "claude-haiku-4-5" }
codex = { model = "gpt-5.4-mini", effort = "low" }
gemini = { model = "gemini-2.5-flash-lite" }
```

## 7. Conversion Logic

```javascript
export function resolveProfileForCli(profile, cli) {
  const r = loadProfile(profile);
  switch (cli) {
    case 'claude': return { model: r.claude.model, effort: mapEffort(r.effort) };
    case 'codex': return { profile: findCodexProfile(r.codex), model: r.codex.model };
    case 'gemini': return { model: r.gemini.model };
  }
}
```

Fallback chain: codex(standard) -> gemini(standard) -> claude(standard)

## 8. Migration Plan

Phase 1 (1d): profiles.toml + mapping table
Phase 2 (2d): profile-resolver.mjs + tfx-route.sh integration
Phase 3 (1d): adapter integration (codex-adapter, gemini-adapter)
Phase 4 (1d): auto-generation from unified profiles, TUI extension

Backward compat: --profile codex53_high and --model gemini-2.5-pro passthrough preserved

## 9. Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| config.toml dual management | Med | auto-generate from unified |
| Gemini no effort | Low | model selection proxy |
| Claude no profiles | Low | env var + API |
| Breaking existing refs | Med | passthrough layer |

## 10. Conclusion

1. Unify via "model + effort" 2D normalization
2. Abstract layer on top of native configs (not replacement)
3. Key benefit: automatic swarm fallback across CLIs

| Metric | Current | Unified |
|--------|---------|---------|
| Management points | 3 | 1 |
| Fallback mapping | manual | automatic |
| New model addition | 3 edits | 1 edit |

## Appendix: Existing to Unified Mapping

| Existing | CLI | Unified |
|----------|-----|---------|
| gpt54_xhigh | Codex | flagship |
| gpt54_high | Codex | standard |
| codex53_high | Codex | coding-heavy |
| codex53_med | Codex | fast |
| codex53_low | Codex | economy |
| mini54_low | Codex | micro |
| pro31 | Gemini | flagship |
| pro25 | Gemini | standard |
| flash3 | Gemini | fast |
| flash25 | Gemini | economy |
| lite25 | Gemini | micro |
