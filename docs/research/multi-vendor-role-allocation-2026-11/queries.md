기간: 2025년 하반기 ~ 2026년 11월. 최신 자료 우선. 특정 벤더나 결론을 전제하지 말고, 반대 사례와 반론도 같이 찾는다.

1. 멀티 에이전트 코딩 하네스와 오케스트레이터(Claude Code 서브에이전트, Codex CLI, Gemini CLI/Antigravity, Cursor, Aider architect/editor, OpenHands, oh-my-opencode 류 플러그인 등)가 역할(계획/설계, 구현, 리뷰, 탐색, 테스트, 문서)별로 어떤 모델을 배정하는지. 공식 기본값과 커뮤니티 권장 설정.
2. 여러 벤더 모델을 섞어 쓰는 사례: 작성 모델과 다른 벤더 모델로 리뷰하기(cross-vendor review)의 근거와 반론, 측정 결과.
3. 쿼터, rate limit, 비용, 지연을 보고 공급자를 바꾸는 LLM 라우터와 게이트웨이(OpenRouter, LiteLLM, Portkey, Not Diamond, Martian 등)의 폴백, 우선순위, 로드밸런싱 방식.
4. 비용-품질 라우팅 연구(RouteLLM, FrugalGPT, 캐스케이드, 라우터 벤치마크 등 2025~2026 논문)의 결론과 한계.
5. 구독형 코딩 플랜 여러 개(ChatGPT/Codex, Claude Max, Google AI Ultra 등)의 사용량 한도를 함께 쓰는 실무 사례와 도구.
6. 역할별 성능 근거: 구현(SWE-bench 계열, Terminal-Bench, FrontierSWE 등), 코드 리뷰 벤치마크, 보안 취약점 탐지 벤치마크, 프런트엔드/디자인(WebDev Arena 등), 문서 작성에서 2026년 최신 모델 가족(OpenAI GPT-6 계열, Anthropic Claude 5 계열, Google Gemini 4 계열) 비교. 벤더 자체 측정과 제3자 측정 구분.
7. 탐색이나 검색 같은 빠른 작업에 작은 모델, 계획과 디버깅에 큰 추론 모델을 쓰는 방식의 실측 근거(지연, 토큰, 성공률).
9. 역할군 분류 자체의 재평가: 요즘 하네스와 연구가 에이전트 역할을 어떤 단위로 나누는지(예: planner, architect, implementer, reviewer, security, explorer, tester, writer, designer, debugger 등). 너무 잘게 나눈 역할이 실제로 다른 모델을 쓸 만큼 차이가 있는지, 합치거나 새로 나눠야 할 역할군이 있는지.
10. 모델 가족별 성능 이점 재평가: OpenAI(Luna, Terra, Sol, Astra 계열 이름이 있으면 그 이름으로), Anthropic(Haiku, Sonnet, Opus, Fable), Google(Gemini 4 Hydrogen, Argon, Carbon, Flash) 각각의 강점과 약점. 정확성(벤치마크 점수, 오류율, 환각)과 속도(첫 토큰 지연, 초당 토큰, 작업 완료 시간), 작업당 토큰 소모와 가격을 함께 수집한다. 자료가 없는 모델은 없다고 적는다.
11. 오케스트레이터와 리드 역할(작업 분해, 워커 배정, 진행 조율, 결과 통합, 장시간 세션 유지)과 소통 역할(사용자나 팀 채팅에 보고, 요약, 질문 중계, 알림)에 어떤 모델을 쓰는지. 리드에 가장 강한 모델을 두는지 저렴하고 빠른 모델을 두는지의 근거, 긴 문맥 유지와 지시 준수 성능, 소통 워커의 응답 속도와 문체 품질 기준. 리드가 여럿이고 계층이 있는 다중 오케스트레이션(리드 위의 리드, 여러 세션이 동시에 돌며 피어 메시지를 주고받는 구조)에서 계층별 모델 배정 사례와 비용 구조.
8. 역할 기반 고정 배정 대신 작업 단위로 모델을 고르는 방식(LLM 판정기, 분류기 라우터)의 실무 채택 사례와 실패 사례.
