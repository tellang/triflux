# tfx-codex Routing Analysis — DRY RUN

**User Request:** `/tfx-codex API 문서를 작성하고 디자인 가이드도 만들어줘`

**Skill Definition Source:** `skills/tfx-codex/SKILL.md`

---

## 1. Trigger Matching

The command prefix `/tfx-codex` matches the skill trigger `tfx-codex` exactly.
The skill is invoked with the argument: `"API 문서를 작성하고 디자인 가이드도 만들어줘"`

---

## 2. TFX_CLI_MODE Environment Variable

```
TFX_CLI_MODE=codex
```

This variable is set for every CLI execution in Phase 3. It forces `tfx-route.sh` to substitute
any `gemini` classification with `codex`, ensuring Gemini CLI is never called.

---

## 3. Task Decomposition (Phase 2 Triage)

The user request contains two distinct subtasks:

| # | Subtask | Natural Agent Assignment | tfx-codex Override |
|---|---------|-------------------------|--------------------|
| 1 | API 문서를 작성 (Write API documentation) | **writer** (originally Gemini) | **Codex Spark** |
| 2 | 디자인 가이드도 만들어줘 (Create design guide) | **designer** (originally Gemini) | **Codex** (effort: high) |

During Phase 2, the Opus decomposition step detects that both subtasks would ordinarily route to
Gemini-backed roles. The `TFX_CLI_MODE=codex` override forces:
- Any `gemini` classification result → replaced with `codex`
- `designer` and `writer` agent types → mapped to Codex with adjusted MCP profiles

---

## 4. Agent Remapping Table

| 에이전트 | 원래 CLI | tfx-codex 매핑 | effort 플래그 |
|----------|---------|---------------|--------------|
| **designer** | ~~Gemini~~ | **Codex** | `effort: high` — UI/시각 코드 생성 |
| **writer** | ~~Gemini~~ | **Codex Spark** | `effort: spark_fast` — 경량 문서 작성 |
| executor, build-fixer, debugger | Codex | Codex | 변경 없음 |
| architect, planner, critic, analyst | Codex | Codex | 변경 없음 |
| code-reviewer, security-reviewer | Codex | Codex | 변경 없음 |
| scientist, document-specialist | Codex | Codex | 변경 없음 |
| explore | Claude Haiku | Claude Haiku | 변경 없음 |
| verifier, test-engineer | Claude Sonnet | Claude Sonnet | 변경 없음 |

---

## 5. MCP Profile Changes for designer and writer

| 에이전트 | 기본 MCP 프로필 | tfx-codex MCP 프로필 | 이유 |
|----------|--------------|---------------------|------|
| **designer** | (Gemini 전용 — 없음) | `implement` | 코드 기반 UI 작업으로 처리 |
| **writer** | (Gemini 전용 — 없음) | `analyze` | 문서 기반 리서치 + 작성 워크플로우 |

Both roles lose access to Gemini's multimodal/creative profile and are instead assigned
Codex-compatible MCP profiles that match the nature of the work:
- `implement` for designer: treats the design guide as a code artifact (e.g., CSS, component specs)
- `analyze` for writer: treats API documentation as a research-and-summarize task

---

## 6. Exact Bash Commands Generated (Phase 3)

### Subtask 1 — writer: API 문서 작성

```bash
TFX_CLI_MODE=codex bash ~/.claude/scripts/tfx-route.sh writer 'API 문서를 작성해줘' analyze
```

- Agent: `writer` → remapped to **Codex Spark** (`effort: spark_fast`)
- MCP Profile: `analyze`
- The `tfx-route.sh` script reads `TFX_CLI_MODE=codex` and substitutes the Gemini path with
  a Codex Spark invocation.

### Subtask 2 — designer: 디자인 가이드 작성

```bash
TFX_CLI_MODE=codex bash ~/.claude/scripts/tfx-route.sh designer '디자인 가이드를 만들어줘' implement
```

- Agent: `designer` → remapped to **Codex** (`effort: high`)
- MCP Profile: `implement`
- The `tfx-route.sh` script reads `TFX_CLI_MODE=codex` and substitutes the Gemini path with
  a full-effort Codex invocation.

---

## 7. Workflow Reference — tfx-auto Phases Followed

Per the skill definition: *"tfx-auto SKILL.md의 전체 워크플로우(커맨드 숏컷 → 트리아지 → 실행 → 결과 파싱 → 보고)를 그대로 따릅니다."*

The exact same phase sequence as `tfx-auto` is executed:

| Phase | Name | tfx-codex 특이사항 |
|-------|------|--------------------|
| Phase 1 | 커맨드 숏컷 파싱 | 동일 (`N:codex` 숏컷 지원) |
| Phase 2 | 트리아지 (Opus 분해) | `gemini` 분류 결과를 `codex`로 강제 변환; designer/writer → Codex + MCP 재할당 |
| Phase 3 | CLI 실행 | `TFX_CLI_MODE=codex` 환경변수 주입하여 `tfx-route.sh` 호출 |
| Phase 4 | 결과 파싱 | 동일 |
| Phase 5 | 보고 | 동일 |

The only deviation from `tfx-auto` occurs in **Phase 2** (forced gemini→codex substitution)
and **Phase 3** (environment variable injection). All other phases are identical.

---

## 8. Summary

For the request `/tfx-codex API 문서를 작성하고 디자인 가이드도 만들어줘`:

- Two subtasks are identified: **writer** (API docs) and **designer** (design guide).
- Both roles were originally mapped to **Gemini CLI** in the default `tfx-auto` routing.
- `tfx-codex` remaps them: `writer` → Codex Spark (`analyze` MCP), `designer` → Codex high-effort (`implement` MCP).
- `TFX_CLI_MODE=codex` is injected at Phase 3 for every `tfx-route.sh` call.
- The full `tfx-auto` 5-phase workflow is followed with the two overrides noted above.
- Gemini CLI is never invoked; no Gemini dependency exists.
