# MCP secrets handling

## 조사 결과

2026-05-20 현재 `tfx mcp sync`의 secret header 처리 결론은 보수적으로 Branch B이다.

- `npm root -g` 결과 글로벌 Node 모듈 위치는 `/opt/homebrew/lib/node_modules`이다.
- 사용자 지정 grep 명령인 `grep -rE "mcpServers|mcp_config|expandEnv|envVar|\$\{" $(npm root -g)/@google/gemini-cli/dist`는 현재 설치본에 `dist`가 없어 매칭이 없었다. 실제 설치본은 `@google/gemini-cli/bundle` 아래에 있다.
- Gemini CLI 번들에는 `createTransportRequestInit()`에서 `mcpServerConfig.headers` 값을 `expandEnvVars(value, sanitizedEnv)`로 처리하는 코드가 있다. 따라서 headers 문자열 보간 자체는 존재한다.
- 다만 headers 보간 입력은 `sanitizeEnvironment(... enableEnvironmentVariableRedaction: true)`를 거친 값이다. Gemini 문서는 `env` block의 `$VAR` / `${VAR}` 확장을 명시하고, 민감 환경변수는 기본 redaction 대상이며 필요 시 `security.allowedEnvironmentVariables`로 명시 허용해야 한다고 설명한다. `EXA_API_KEY` 같은 이름은 secret pattern에 걸릴 수 있으므로, `${EXA_API_KEY}` header만 쓰는 마이그레이션은 기본 설정에서 빈 header가 될 수 있다.
- Antigravity CLI(`agy`)는 `strings /Users/tellang/.local/bin/agy | grep -E '\$\{|expandEnv|envSubst'`에서 설정 header 보간으로 판단할 수 있는 안정적인 흔적을 찾지 못했다.
- Antigravity MCP 공식 문서(`https://antigravity.google/docs/mcp`)는 WebFetch 시도에서 SPA HTML만 반환되어 본문 근거를 확보하지 못했다.
- Antigravity plugin sample인 `~/.gemini/antigravity-cli/plugins/chrome-devtools-mcp/mcp_config.json`은 `env: null` 형태이며 header/env 보간 예시를 제공하지 않는다.

운영 결론: Codex는 `env_http_headers` / `bearer_token_env_var`로 secret을 설정 파일 밖에 둘 수 있지만, Gemini/Antigravity JSON 설정은 지금 단계에서 Bearer header secret을 평문으로 쓴다. Gemini는 향후 allowlist까지 함께 관리하는 별도 마이그레이션이 가능하지만, 이 PR에서는 secret header 보간을 자동 적용하지 않는다.

## 현재 상태

`config/mcp-registry.json`의 header descriptor는 registry에 secret 값을 저장하지 않는다.

```json
{
  "headers": {
    "Authorization": { "env": "EXA_API_KEY", "prefix": "Bearer " }
  }
}
```

대상별 sync 결과는 다르다.

- Codex: `~/.codex/config.toml`에 `bearer_token_env_var` 또는 `env_http_headers`를 기록한다. 런타임이 환경변수 값을 header로 조립하므로 config 파일에 Bearer token 평문이 남지 않는다.
- Gemini: `~/.gemini/settings.json`의 `mcpServers.<name>.headers.Authorization`에 resolved Bearer token을 기록한다.
- Antigravity: Task A가 Antigravity target을 추가하면 `~/.gemini/config/mcp_config.json`도 같은 JSON header 구조를 쓰는 것으로 취급한다.

## Mitigation

- Gemini/Antigravity JSON config를 쓸 때 파일 권한을 `0600`으로 강제한다.
- env descriptor에서 secret header가 resolved plaintext로 기록될 때 `tfx mcp sync`는 stderr warning을 출력한다.
- secret 값은 `config/mcp-registry.json`, docs, PR body, test fixture에 직접 쓰지 않는다. 테스트는 임시 token 문자열만 사용한다.
- 운영 환경에서는 `secrets.env` 또는 shell secret manager에서 `EXA_API_KEY`를 주입하고 registry에는 env var 이름만 둔다.
- 가능하면 remote MCP의 OAuth flow를 우선 사용한다. Gemini CLI는 MCP OAuth token을 별도 token store에서 관리할 수 있다.
- API key 방식이 필요하면 token rotation 주기를 문서화하고, 노출이 의심될 때 즉시 revoke/rotate한다.

## Migration path

Gemini/Antigravity가 secret header 보간을 안전하게 지원한다고 검증되면 다음 순서로 이전한다.

1. Gemini: `${EXA_API_KEY}` header 보간이 민감 env redaction과 충돌하지 않는지, 또는 `security.allowedEnvironmentVariables`를 함께 관리해야 하는지 먼저 테스트한다.
2. Antigravity: `mcp_config.json`의 `mcpServers.<name>.headers`에서 `$VAR` / `${VAR}`가 실제 request header로 확장되는지 공식 문서 또는 실행 테스트로 확인한다.
3. `mcp-guard-engine`의 JSON target writer를 resolved plaintext 대신 interpolation string writer로 전환한다.
4. plaintext warning을 migration warning으로 낮추고, 기존 plaintext config를 interpolation config로 rewrite하는 regression test를 추가한다.
5. 실제 home 파일 검증은 temp HOME 또는 dry-run equivalent로 먼저 수행한 뒤, 사용자 home에 적용한다.
