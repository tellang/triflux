# 핸드오프: 세션 08 - 리팩토링 및 시스템 최적화

## 세션 요약
- **날짜:** 2026-03-11
- **브랜치:** `dev`
- **커밋:** `ab6b2e2`, `4abf746`

---

## 완료된 작업

### P0 (즉각 대응)
1. **인코딩 및 데이터 절단 버그 수정 (`tfx-route-post.mjs`)**
   - 구조적 출력(Structured Output) 내의 한국어 및 비ASCII 문자를 ASCII로 교체하여 호환성 확보.
   - UTF-8 멀티바이트 경계에서 안전하게 데이터를 절단하는 로직을 추가하여 깨진 문자(replacement char) 발생 방지.
2. **Codex stdout 복구 로직 검증**
   - `awk`를 이용한 응답 추출 로직이 단일/다중 마커 및 마커 미발견 케이스에서 정상 작동함을 확인.

### P1 (중요 성능 개선)
3. **`tfx-auto` 스킬 슬리밍 (Token Optimization)**
   - `skills/tfx-auto/SKILL.md` 파일을 665줄에서 191줄로 대폭 축소 (약 71% 감소).
   - 상세 구현 가이드는 `docs/tfx-auto-internals.md`로 분리하여 호출당 약 5K 토큰 절감.
4. **신뢰 소스(Truth Source) 단일화**
   - `hub/team/native.mjs`의 `buildSlimWrapperPrompt()`가 시스템 프롬프트의 유일한 기준이 되도록 수정. `SKILL.md`는 이를 참조하는 구조로 변경.

### P2 (구조 개선 및 도구 강화)
5. **Troubleshooting 섹션 통합**
   - `tfx-codex`, `tfx-gemini`, `tfx-auto-codex`, `tfx-setup` 등 4개 스킬에 중복되어 있던 문제 해결 가이드를 통합하여 관리 효율성 증대.
6. **유령 팀(Orphan Team) 자동 정리 기능 추가**
   - `triflux doctor`에 'Section 11' 추가.
   - `~/.claude/teams/`에 잔존하는 유효하지 않은 팀 세션을 감지하고, `--fix` 옵션을 통해 자동 정리 기능 구현.

---

## 변경 파일
- `bin/triflux.mjs`: 유령 팀 감지 및 정리 로직 추가 (+41줄)
- `hub/team/native.mjs`: 프롬프트 신뢰 소스 강화
- `skills/tfx-auto/SKILL.md`: 665→191줄로 최적화
- `skills/tfx-team/SKILL.md`: 중복 프롬프트 제거
- `skills/tfx-codex/SKILL.md`, `tfx-gemini/SKILL.md`, `tfx-auto-codex/SKILL.md`, `tfx-setup/SKILL.md`: Troubleshooting 섹션 통합
- `skills/tfx-doctor/SKILL.md`: 유령 팀 체크 항목 추가
- `docs/tfx-auto-internals.md`: (신규) `tfx-auto` 상세 내부 로직 문서화
- `~/.claude/scripts/tfx-route-post.mjs`: 인코딩 및 데이터 절단 로직 수정 (git 외부 관리 파일)

---

## 미완료 작업 (다음 세션 제안)

### P1-4: Effort 자동 선택 로직 구현
- 현재 에이전트별로 고정된 Effort 값을 사용 중임.
- 트리아지 단계에서 작업 복잡도(S/M/L)를 분석하여 `spark`, `executor`, `deep-executor`에 자동으로 매핑하는 기능 필요.
- 간단한 수정임에도 고정된 high effort로 인해 불필요한 대기 시간(108~294초)이 발생하는 문제 해결 목적.

### ~~P2-6: 백그라운드 프로세스 실시간 가시성 확보~~ (완료)
- `tfx-route.sh`에 조건부 `tee` 도입 (`f5c0765`).
- `TFX_TEAM_NAME` 설정 시(팀 모드) → `tee`로 파일+터미널 동시 출력 (Shift+Down 실시간 가시성).
- 미설정 시(tfx-auto 직접 Bash) → 기존 파일 전용 유지 (Lead 토큰 절약).
- 팀 모드에서도 Codex가 무료 작업 수행 → Sonnet 직접 대비 80~90% 토큰 절감.

### 기타 제안
- `tfx-route.sh` v2.1: CLI 인자로 직접 Effort 파라미터를 지원하도록 업데이트.
- `post.mjs`: Gemini 세션 토큰 추출의 정확도 향상.
- AIMD 기반의 배치 사이즈 자동 조절 로직 검증.

---

## 핵심 인사이트
- **Codex Exec Review 모드 특성:** `stdout`은 0바이트로 출력되지만, `stderr` 끝에 `"codex\n"` 마커 이후 실제 응답이 출력됨. 이를 `awk`로 파싱하여 복구하는 것이 핵심.
- **UTF-8 절단 안전성:** `Buffer.subarray` 사용 시 멀티바이트 중간이 잘리면 데이터가 오염됨. 바운더리를 안전하게 후퇴시키는 로직이 시스템 안정성에 기여함.
- **토큰 경제성:** `SKILL.md`를 슬리밍하고 상세 내용을 `docs/`로 분리하는 것만으로도 운영 성능을 저해하지 않으면서 상당량의 비용과 컨텍스트 공간을 절약할 수 있음.
- **유령 팀의 위험성:** `TeamDelete`가 정상적으로 수행되지 않으면 OMC 훅이 실행 중인 팀을 반복 감지하여 무한 루프를 유발할 수 있음.
