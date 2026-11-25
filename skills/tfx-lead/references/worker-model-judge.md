# 워커 모델 조회와 Jev 호출 범위

- 워커 모델과 effort를 세션 없이 조회하려면 `tfx judge worker-model --task '<요약>' [--agent executor] [--cli codex|claude|agy]`를 쓴다. 역할 기본값과 Jev 조정을 재사용하며 `source`와 `fallbackReason`으로 폴백을 구분한다. 실제 headless 실행은 같은 정책을 적용하므로 부모가 실행 전 같은 작업을 다시 조회하지 않는다. 명시 model/effort 쌍, retry와 작성 벤더별 리뷰 정책이 자동 추천보다 우선한다. `.model.json`과 결과의 `workerModelFile`은 실행 인자 전달 기록이며 실제 런타임 수신 증거가 아니다.
- Jev는 enabled 상태이고 실제 연동 판단 지점(사전 라우팅, 스킬 분기 선택, 워커 권한, 워커 상태, 수신함 우선순위 등)이 실행될 때만 호출되며, 실패하거나 신뢰도가 낮으면 기존 결정론적 로직으로 돌아간다. HUD의 `j`는 활성 배지이며 호출 성공을 뜻하지 않는다. 리드 지정으로 새로 호출되거나 일반 대화 전체를 자동 판단하지 않는다. 인증 값은 읽거나 출력하지 않는다.

