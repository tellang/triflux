---
id: 0048
title: Codex Terra 가족을 더하고 글쓰기 레인을 Terra 로 옮긴다
status: accepted
date: 2026-10-28
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0037, 0039]
pr: null
---

# ADR-0048: Codex Terra 가족을 더하고 글쓰기 레인을 Terra 로 옮긴다

## 결정

GPT-6.1 Terra 가 나와 Codex 모델 가족에 `terra`를 더하고 `terra_high` 프로필을 만든다. 해석기는 다른 가족처럼 `models_cache.json`에서 같은 가족의 최신 버전을 고른다.

직접 Codex 를 지정했을 때의 `writer`(이전 `luna_high`)와 `document-specialist`(이전 `sol_high`)를 `terra_high`로 옮긴다. OpenAI 공식 문서가 Terra 를 "글쓰기, 시각 이해, 컴퓨터 사용에 빠르고 효율적인 모델"로 둔다(developers.openai.com/codex/models, /api/docs/models/gpt-6.1-terra). 두 레인의 일반 실행 provider 는 `hub/team/agent-map.json`과 ADR-0039 그대로다.

## 검토한 대안

- `designer`와 `qa-tester`도 Terra 로 옮기기: 공식 문서의 Terra 강점은 시각 이해와 앱 화면 조작이고 디자인 생성이나 판단은 Astra 쪽에 둔다. triflux 의 `qa-tester`는 GUI 가 아니라 tmux 로 CLI 를 다룬다. 둘 다 근거가 맞지 않아 버렸다.
- 가족만 더하고 레인은 그대로 두기: 공식 문서가 글쓰기를 Terra 의 첫 용도로 두므로 글쓰기 레인은 옮기는 편이 맞다고 사용자가 정했다.
