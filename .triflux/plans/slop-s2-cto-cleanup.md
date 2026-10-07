# S2 CTO 조회 축소 계획

범위: 현재 worktree의 CTO 코드, 직접 소비자 테스트, 명시된 CLI schema, pack 목록, 패키지 미러, 관련 안내 문서와 ADR. bin/tfx-live.mjs 및 hygiene-notify.mjs는 보존한다.

1. 삭제 후보 파일 전체를 읽고 저장소 전체 참조를 확인한다. 지정되지 않은 실행 소비자가 있으면 보류한다.
2. 기존 CTO 테스트로 collect 기록, status JSON 및 live overlay, hygiene dry-run 무변경 동작을 잠근다.
3. steward, event CLI, hygiene apply, dashboard 및 수집원 3개를 제거한다. 삭제 기능 전용 테스트도 제거한다.
4. events의 ledger 잠금 함수를 collect에서도 사용한다. collect 이벤트를 허용하고 기존 ref {current_json,current_md,sources_json} 형식을 보존한다. appended boolean을 읽어 ledger tail을 갱신한다.
5. 공통 시간, 경로, 해시, JSONL, 원자 쓰기 함수를 lake-root/events에 모은다. synapse persisted snapshot은 읽기만 하며 hub/team import를 제거한다. active와 idle 세션 및 경로 가림은 유지한다.
6. status 사람용 출력에 생성 시각과 경과 시간을 표시한다. 실제 출력 및 dry-run 무변경, ledger 잠금 회귀만 검증한다.
7. 별도 문서 작성 패스에서 ADR과 현 안내를 맞추고, 별도 검토 패스에서 계획과 diff를 검토한다.
8. index 직접 실행 guard를 추가하고 collect --help는 root/lake 해석과 모든 쓰기 전에 반환한다. worktree가 main lake를 읽는 기존 정책은 보존하고 smoke는 status 조회와 help만 실행한다.
9. 지정 테스트, 직접 소비자 테스트, Biome, mirror, check-sync, ADR 구조 및 CLI/import smoke를 실행한다. 커밋과 PR은 만들지 않는다.

대체 경로 분류: git common-dir 조회 실패 시 .git 상향 탐색은 기존 저장소 탐색 호환 동작으로 유지한다. 누락된 durable artifact는 available:false, 잠긴 ledger는 경고와 skipped append로 남긴다. synapse 손상/타임아웃은 기존 빈 overlay 경계를 유지하되 테스트로 잠근다. 새로운 fallback 계층이나 의존성은 추가하지 않는다.

완료 조건: 삭제 경로의 실행 참조가 없어야 하고 보존 API와 조회 결과가 검증되어야 한다. sources 키 감소(11개에서 8개), 삭제된 CLI, 보류 항목 및 검증 누락은 결과에 명시한다.
