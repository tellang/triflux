# Handoff: triflux 매직워드 시스템 + 배치 키워드 추출

> 세션 날짜: 2026-03-10
> 프로젝트: triflux (매직워드) + session-vault (배치 파이프라인)

## 완료된 작업

### 1. triflux 독립 매직워드 엔진 (완료)

OMC와 독립적으로 동작하는 triflux 전용 keyword-detector 구현 완료.

**생성된 파일:**
- `hooks/keyword-rules.json` — 12개 규칙 (5 tfx 커맨드 + 7 MCP 라우팅)
- `scripts/keyword-detector.mjs` — 메인 탐지기 (stdin JSON → hookSpecificOutput)
- `scripts/lib/keyword-rules.mjs` — 규칙 로더/매처/충돌 해소
- `scripts/run.cjs` — Node.js 크로스 플랫폼 래퍼
- `hooks/hooks.json` — team-keyword.mjs → keyword-detector.mjs 교체 완료

**핵심 설계:**
- 네임스페이스: `[TRIFLUX MAGIC KEYWORD:]` / `[TRIFLUX MCP ROUTE:]` (OMC와 구분)
- 상태 경로: `.triflux/state/` (`.omc/` 미사용)
- 규칙 외부화: `keyword-rules.json` 수정만으로 키워드 추가/삭제
- 환경변수: `TRIFLUX_DISABLE_MAGICWORDS=1`, `TRIFLUX_SKIP_HOOKS=keyword-detector`

**MCP 라우팅 규칙:**
| 키워드 | 라우팅 | 이유 |
|--------|--------|------|
| 노션/notion | gemini | 긴 페이지 콘텐츠, 토큰 폭증 |
| 크롬/chrome/브라우저 | gemini | DOM 트리 70k+ 토큰 |
| jira/지라 | codex | 구조적 데이터 |
| 메일/gmail | gemini | Google 에코시스템 |
| 일정/캘린더 | gemini | Google 에코시스템 |
| playwright | gemini | 브라우저 자동화 |
| canva | gemini | 디자인 메타데이터 |

**테스트 결과 (3/3 통과):**
- `tfx team ...` → `[TRIFLUX MAGIC KEYWORD: tfx-team]` ✓
- `노션 페이지 생성` → `[TRIFLUX MCP ROUTE: gemini]` ✓
- 일반 대화 → `suppressOutput: true` ✓

### 2. session-vault 배치 키워드 추출 파이프라인 (완료)

원격 Ryzen Ollama (Qwen 3.5 9B)로 10,329개 user 턴에서 키워드 자동 추출.

**생성된 파일:**
- `session-vault/scripts/extract_keywords.py` — 배치 추출기
- `session-vault/pyproject.toml` — httpx 의존성 추가

**원격 환경:**
- Ryzen 5 7600 + RX 6700XT 12GB VRAM (Vulkan)
- Ollama: `http://100.116.114.116:11434` (Tailscale)
- 모델: `qwen3.5:9b` Q4_K_M (6.6GB)
- 성능: ~226 tok/s

**CLI:**
```bash
cd ~/Desktop/Projects/tools/session-vault
uv sync
python scripts/extract_keywords.py --dry-run --limit 10  # 테스트
python scripts/extract_keywords.py --limit 100            # 소규모
python scripts/extract_keywords.py                         # 전체
python scripts/extract_keywords.py --project triflux       # 프로젝트별
python scripts/extract_keywords.py --ollama-url http://localhost:11434  # URL 변경
python scripts/extract_keywords.py --model qwen3:8b        # 모델 변경
```

### 3. MCP 라우팅 규칙 (완료, keyword-rules.json에 통합)

keyword-rules.json에 7개 MCP 라우팅 규칙 포함. 별도 구현 불필요.

## 남은 작업 (우선순위순)

### P0: 배치 실행 + 키워드 수확 (미완 — session-vault 작업)

```bash
# 1. 원격 Ollama 연결 확인
curl -sf http://100.116.114.116:11434/api/ps

# 2. Qwen 3.5 모델 로드
curl -sf http://100.116.114.116:11434/api/generate -d '{"model":"qwen3.5:9b","keep_alive":"10m"}'

# 3. 소규모 테스트 (10개)
python scripts/extract_keywords.py --limit 10

# 4. 결과 확인
python3 -c "
import sqlite3
conn = sqlite3.connect('sessions_v2.db')
tags = conn.execute(\"SELECT t.tag, count(*) FROM tags t JOIN turn_tags tt ON t.id=tt.tag_id WHERE tt.source='ollama-qwen35' GROUP BY t.tag ORDER BY count(*) DESC LIMIT 20\").fetchall()
for t in tags: print(f'  {t[0]}: {t[1]}')
"

# 5. 전체 실행 (예상 ~1시간)
python scripts/extract_keywords.py
```

### P1: 추출된 키워드 → keyword-rules.json 자동 확장 (완료)

`scripts/keyword-rules-expander.mjs` 구현 완료.
- better-sqlite3로 session-vault DB 조회, ollama-* 소스 필터링
- 기존 규칙 매칭 제외, threshold 기반 후보 추출
- `--dry-run` / `--apply` / `--threshold N` / `--db-path` CLI 지원
- tfx-* → skill 후보, MCP 서비스명 → mcp_route 후보, 기타 → 수동 검토

```bash
node scripts/keyword-rules-expander.mjs --dry-run           # 후보만 출력
node scripts/keyword-rules-expander.mjs --threshold 5       # 최소 5회 등장
node scripts/keyword-rules-expander.mjs --apply              # keyword-rules.json에 추가
```

### P2: 테스트 하네스 (완료)

`scripts/__tests__/keyword-detector.test.mjs` 구현 완료.
- node:test + node:assert/strict, 13개 테스트 전부 통과
- 케이스: extractPrompt 우선순위, sanitize, loadRules, compileRules, matchRules(tfx/MCP/일반), resolveConflicts(priority/supersedes/exclusive), 코드블록 오탐 방지, OMC 비간섭

```bash
node --test scripts/__tests__/keyword-detector.test.mjs
```

### P3: team-keyword.mjs deprecation (완료)

- `scripts/team-keyword.mjs` 삭제 완료
- 코드/설정 참조 0건 확인, hooks.json은 이미 keyword-detector.mjs 사용 중

## 참고 데이터

### session-vault DB 요약
- 908 세션, 37,542 턴 (user: 10,329 / assistant: 27,213)
- 57개 프로젝트, 상위: Projects root(376), speaky(94), gamma(49), triflux(43)
- 기존 태그: 418개, turn_tags: 593개
- 상세 분석: `session-vault/reports/session_vault_analysis_2026-03-10.json`

### Codex 분석 보고서 (OMC 매직워드)
- OMC keyword-detector.mjs 완전 분석 완료
- 15개 키워드, regex 매칭, priority sort, state management
- 상세: 이전 세션 t2 Codex 출력 참조

### Gemini 분석 보고서 (MCP 라우팅)
- 브라우저 자동화 최고 위험 (70k+/page)
- Notion/Confluence 높음, Jira 중간
- Gemini CLI `mcpServers` 설정으로 동일 MCP 접근 가능
- Claude 토큰 60%+ 절감 가능
