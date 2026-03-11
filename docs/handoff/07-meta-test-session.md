# tfx-team 메타 테스트 세션 핸드오프

> 날짜: 2026-03-11 | 모델: Opus 4.6 오버시어

## 완료된 작업

### 1. tfx-team 메타 테스트 (4 워커 spawn)
- codex-worker-1 (security-reviewer): tfx-route.sh 보안 분석 → 8단계 sequential-thinking
- codex-worker-2 (code-reviewer): native.mjs 코드 리뷰 → 7단계 분석
- gemini-worker-1 (writer): SKILL.md 7개 문서 품질 분석 → 크로스컷 리포트
- gemini-worker-2 (designer): CLI UX 분석 → P0~P3 권장 5건

### 2. 종합 평가 (6개 기준)
| 기준 | 점수 |
|------|------|
| 토큰 효율성 | 4/10 |
| 속도 | 6/10 |
| 정확도 | 7/10 |
| 강건성 | 4/10 |
| 복원성 | 4/10 |
| 가시성 | 2/10 |

### 3. 수정 적용 (3 Codex executor 병렬)
- **tfx-route.sh**: json_escape 제어문자, timeout 검증, codex stdout 복구
- **native.mjs**: status:"failed"→completed+metadata, 셸 변수 인용
- **SKILL.md**: 342→308줄 슬리밍 (비교 테이블, tmux, 매핑 축소)

## 발견된 버그 (확정, 수정/미수정)

| # | 심각도 | 위치 | 설명 | 상태 |
|---|--------|------|------|------|
| 1 | CRITICAL | tfx-route.sh L513 | codex exec review stdout 0 bytes | ✅ 워크어라운드 적용 (stderr에서 복구) |
| 2 | HIGH | native.mjs L34,121 | status:"failed" API 미지원 | ✅ 수정 |
| 3 | HIGH | native.mjs L118 | 셸 변수 미인용 | ✅ 수정 |
| 4 | HIGH | SKILL.md vs native.mjs | 프롬프트 이중 truth source | ⚠️ 인지됨, 미수정 |
| 5 | MEDIUM | tfx-route.sh L65-73 | json_escape 제어문자 누락 | ✅ 수정 |
| 6 | MEDIUM | tfx-route.sh L453 | timeout 검증 없음 | ✅ 수정 |
| 7 | MEDIUM | tfx-route-post.mjs L609 | 인코딩 버그 (exit 127) | ❌ 미수정 |
| 8 | MEDIUM | Hub bridge | Task 상태 불일치 | ⚠️ 인지됨, 미수정 |
| 9 | LOW | native.mjs L129 | generateTeamName 충돌 | ⚠️ 인지됨 |
| 10 | LOW | ~/.claude/teams/ | 이전 세션 팀 잔존 | ⚠️ 인지됨 |

## 미완료 작업 (다음 세션)

### P0 — 즉시
1. **tfx-route-post.mjs 인코딩 버그** — exit 127 유발. post.mjs가 출력하는 텍스트에 비ASCII 문자 포함되어 bash가 커맨드로 해석. 파일: `~/.claude/scripts/tfx-route-post.mjs` 마지막 출력 부분 확인
2. **codex stdout 복구 로직 검증** — awk 마커 추출이 실제 Codex review 출력에서 정확히 동작하는지 `codex exec --profile thorough ... review` 실행 후 테스트 필요

### P1 — 중요
3. **tfx-auto SKILL.md 슬리밍** — 현재 666줄(~7K tok). DAG 실행 상세를 docs/로 분리하여 200줄 이내 목표
4. **effort 자동 선택** — 트리아지에서 작업 복잡도(S/M/L) 판단하여 spark/executor/deep-executor 자동 매핑
5. **SKILL.md vs native.mjs truth source 통일** — 슬림 래퍼 프롬프트는 native.mjs만 truth source로, SKILL.md는 참조만

### P2 — 개선
6. **실시간 가시성** — `tee` 도입으로 파일+터미널 동시 출력, Shift+Down 시 실제 내용 표시
7. **이전 팀 잔존 정리** — tfx-doctor에 orphan team 감지+정리 로직 추가
8. **Troubleshooting 섹션 통합** — 5개 스킬의 중복 삭제, `/tfx-doctor 실행하세요` 한 줄로

## 변경된 파일 (git diff 확인용)

```
modified: hub/team/native.mjs           # 3곳 수정
modified: skills/tfx-team/SKILL.md      # 슬리밍 (342→308줄)
modified: ~/.claude/skills/tfx-team/SKILL.md  # 동일 (git 외부)
modified: ~/.claude/scripts/tfx-route.sh      # 3곳 수정 (git 외부)
```

## 워커 결과 로그 (참고용)

```
/tmp/tfx-route-security-reviewer-1773213089-stderr.log  # 23KB, sequential-thinking 보안 분석
/tmp/tfx-route-code-reviewer-1773213072-stderr.log      # 35KB, sequential-thinking 코드 리뷰
/tmp/tfx-route-writer-1773213082-stdout.log             # 7.8KB, 문서 품질 분석
/tmp/tfx-route-designer-1773213089-stdout.log           # 6.8KB, UX 분석
```

## 핵심 인사이트

- **Codex `exec review` 모드**: 최종 텍스트 응답이 stderr 끝에 `codex\n` 마커 후 출력됨. stdout에는 아무것도 안 감.
- **슬림 래퍼 Agent**: "Bash 1회만" 지시에도 파일 읽기/도구 로드를 추가 수행 → 프롬프트를 더 강하게 제약 필요
- **effort=high 기본값**: 간단한 3줄 수정도 108~294초 소요. spark/fast 프로필 자동 선택 메커니즘 필요
- **post.mjs 인코딩**: 3개 태스크 전부 동일 에러 → 재현성 100%, 시급 수정 대상
