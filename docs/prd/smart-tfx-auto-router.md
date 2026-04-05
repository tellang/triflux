# PRD: Smart tfx-auto — 단일 진입점 통합 라우터 + 선호도 학습

## 목표

tfx-auto를 스마트 라우터로 강화하여 40개 tfx 스킬의 구현 진입점을 1개로 통합한다.
사용자 선호도를 학습하여 라우팅 가중치를 자동 조정한다.

## 설계 문서

`~/.gstack/projects/tellang-triflux/tellang-main-design-20260406-004604.md`

## 파일

### 1. `packages/triflux/skills/tfx-auto/SKILL.md` (수정, ~30줄 추가)

기존 tfx-auto SKILL.md의 워크플로우 시작 부분에 스마트 라우팅 판단 로직을 추가한다.

```markdown
### Step 0: 스마트 라우팅 (tfx-auto 진입 시 자동 실행)

preamble에서 routing-weights.json을 읽고, 사용자 입력을 분석하여 dispatch 결정.

\`\`\`bash
SLUG=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")
WEIGHTS_FILE="$HOME/.gstack/projects/$SLUG/routing-weights.json"
USER_MODE=""
if [ -f "$WEIGHTS_FILE" ]; then
  USER_MODE=$(node -e "
    const w=JSON.parse(require('fs').readFileSync('$WEIGHTS_FILE','utf8'));
    const m=w.weights?.mode_bias||{};
    const top=Object.entries(m).sort((a,b)=>b[1]-a[1])[0];
    if(top && top[1]>0.3) console.log(top[0]);
  " 2>/dev/null)
fi
echo "USER_PREFERRED_MODE: ${USER_MODE:-none}"
\`\`\`

판단 기준 (우선순위 순):

1. 사용자 명시 키워드 (최우선):
   - "병렬", "swarm", "PRD 돌려" → `/tfx-swarm` dispatch
   - "꼼꼼히", "제대로", "deep" → `/tfx-deep-*` dispatch
   - "끝까지", "멈추지마", "ralph" → `/tfx-persist` dispatch
   - "multi", "팀", "협업" → `/tfx-multi` dispatch
   - "codex로", "gemini로" → `/tfx-codex` 또는 `/tfx-gemini` dispatch

2. PRD 인자 분석:
   - PRD 경로 2개 이상 → `/tfx-swarm` dispatch
   - PRD 1개 + XL 규모 → `/tfx-fullcycle` dispatch

3. 선호도 가중치 (tiebreaker):
   - USER_PREFERRED_MODE가 있고 가중치 > 0.3이면 제안
   - "[tfx] 사용자 선호: {mode}. 이 모드로 실행할까요?" 1줄 표시
   - 5초 내 응답 없으면 기본(auto) 진행

4. 기본: 기존 tfx-auto 워크플로우 그대로 실행
```

dispatch 시 해당 스킬을 Skill 도구로 호출한다. dispatch하지 않으면 기존 auto 워크플로우 진행.

라우팅 결정 후 1줄 표시:
```
[tfx] 규모: L, 모드: tfx-auto (codex53_high) — 오버라이드: /tfx-multi, /tfx-swarm 등
```

### 2. `hooks/keyword-rules.json` (수정, ~30줄 변경)

기존 구현 관련 규칙들을 `tfx-auto`로 통합한다.

**제거할 규칙:**
- `tfx-auto` (기존 — 패턴을 통합 규칙으로 이동)
- `tfx-auto-codex`
- `tfx-codex` (구현 요청 패턴만. "/tfx-codex"직접 호출은 하위호환)

**추가할 통합 규칙:**
```json
{
  "id": "tfx-unified",
  "patterns": [
    { "source": "\\btfx[\\s-]?auto\\b", "flags": "i" },
    { "source": "(?:만들어|고쳐|구현해|짜줘|수정해|바꿔)", "flags": "i" },
    { "source": "(?:리뷰해|검토해|봐줘|괜찮아)", "flags": "i" },
    { "source": "(?:테스트|검증|돌려봐|QA)", "flags": "i" },
    { "source": "(?:분석해|계획|설계해)", "flags": "i" },
    { "source": "(?:찾아봐|조사해|검색해)", "flags": "i" },
    { "source": "(?:정리해|슬롭|클린업)", "flags": "i" },
    { "source": "\\b(?:implement|build|fix|review|test|plan|analyze)\\b", "flags": "i" }
  ],
  "skill": "tfx-auto",
  "priority": 2,
  "supersedes": ["tfx-auto-codex"],
  "exclusive": false
}
```

**유지할 규칙 (명시적 모드 요청):**
- `tfx-swarm` — "swarm", "병렬", "codex swarm" 등
- `tfx-multi` — "multi", "팀 모드" 등
- `tfx-cancel` — 취소

**유지할 규칙 (인프라):**
- `tfx-hub`, `tfx-doctor`, `tfx-setup`, `tfx-autoresearch`, `tfx-deep-interview`

### 3. `hooks/hook-orchestrator.mjs` (수정, ~15줄 추가)

스킬 dispatch 후 결과를 routing-weights.json에 기록하는 로직 추가.

AfterResponse 훅 또는 스킬 완료 시점에서:
```javascript
// 라우팅 결과 기록
function recordRouteOutcome(slug, mode, outcome) {
  const weightsPath = join(GSTACK_HOME, 'projects', slug, 'routing-weights.json');
  const weights = existsSync(weightsPath)
    ? JSON.parse(readFileSync(weightsPath, 'utf8'))
    : { updated_at: null, total_routes: 0, overrides: 0, weights: { mode_bias: {}, profile_bias: {}, depth_bias: {} } };

  weights.total_routes++;
  weights.updated_at = new Date().toISOString();

  const bias = weights.weights.mode_bias;
  const current = bias[mode] || 0;

  if (outcome === 'override') {
    bias[mode] = Math.max(0, current - 0.1);
    weights.overrides++;
  } else if (outcome === 'completion') {
    bias[mode] = Math.min(1, current + 0.05);
  } else if (outcome === 'abort') {
    bias[mode] = Math.max(0, current - 0.1);
  }

  // 정규화: 합이 1이 되도록
  const total = Object.values(bias).reduce((s, v) => s + v, 0);
  if (total > 0) {
    for (const key of Object.keys(bias)) {
      bias[key] = +(bias[key] / total).toFixed(3);
    }
  }

  writeFileSync(weightsPath, JSON.stringify(weights, null, 2), 'utf8');
}
```

### 4. internal 스킬 frontmatter (수정, 각 1줄 추가)

아래 스킬의 SKILL.md frontmatter에 `internal: true` 추가:

```
tfx-autopilot, tfx-autoroute, tfx-auto-codex, tfx-codex, tfx-gemini,
tfx-fullcycle, tfx-persist, tfx-ralph, tfx-consensus,
tfx-plan, tfx-review, tfx-qa, tfx-analysis, tfx-research, tfx-autoresearch,
tfx-find, tfx-prune, tfx-debate, tfx-panel, tfx-interview,
tfx-deep-analysis, tfx-deep-plan, tfx-deep-qa, tfx-deep-research, tfx-deep-review
```

`internal: true`는 help/목록에서 숨기기 용도. 직접 호출은 여전히 가능 (하위호환).

## 제약

- tfx-auto 기존 워크플로우는 100% 유지. Step 0이 dispatch하지 않으면 기존 흐름 진행
- routing-weights.json은 ~/.gstack/projects/{slug}/에 저장 (프로젝트별 독립)
- 가중치는 제안만, 강제 아님. 규칙 기반 결정이 항상 1순위
- 30일 decay: 갱신 안 된 가중치는 0.5배 감쇠
- 토큰 비용: Layer 0 (hook) = 0, Layer 1 (preamble bash) = 0

## 의존성

- swarm-planner.mjs (규모 산정 — swarm dispatch 시에만)
- hook-orchestrator.mjs (결과 기록)
- keyword-rules.json (패턴 매칭)

## 테스트 명령

```bash
npm test
```

## 완료 조건

1. `/tfx-auto 구현해줘` → 기존대로 동작 (회귀 없음)
2. 자연어 "만들어줘" → keyword-rules → tfx-auto로 라우팅
3. "병렬로 돌려" → tfx-auto Step 0에서 tfx-swarm으로 dispatch
4. override 발생 시 routing-weights.json 갱신
5. 기존 `/tfx-codex`, `/tfx-multi` 직접 호출도 동작 (하위호환)
6. `internal: true` 스킬이 help 목록에서 숨겨짐
