# Swarm Full Smoke Test — Local + Remote

목적: 3모델 x 2기기 스웜 end-to-end 검증

## Shard: ping-codex
- agent: codex
- files: .triflux/swarm-test/target-a.mjs
- prompt: Add a single comment "// codex was here — local" at the top of .triflux/swarm-test/target-a.mjs. Do not change anything else.

## Shard: ping-gemini
- agent: gemini
- files: .triflux/swarm-test/target-b.mjs
- prompt: Add a single comment "// gemini was here — local" at the top of .triflux/swarm-test/target-b.mjs. Do not change anything else.

## Shard: ping-claude-m2
- agent: claude
- host: m2
- files: .triflux/swarm-test/target-c.mjs
- prompt: Add a single comment "// claude was here — m2 remote" at the top of .triflux/swarm-test/target-c.mjs. Do not change anything else.
