#!/usr/bin/env node
// PreToolUse:Agent hook — triflux 프로젝트 기본 에이전트 라우팅
// 특정 시스템을 차단하지 않고, triflux의 의도를 context로 주입

console.log(
  "triflux 프로젝트 기본: Agent spawn 시 subagent_type='general-purpose'를 사용하세요. " +
  "프로젝트 스킬(tfx-*)이 활성 상태이면 스킬 MD의 라우팅 지시를 우선합니다."
);
