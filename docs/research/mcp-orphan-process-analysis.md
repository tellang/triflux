# Claude Code MCP 서버 고아 프로세스 분석 (Orphaned MCP Process Analysis)

## 1. 요약 (Executive Summary)
본 문서는 Claude Code 사용 시 Windows 환경에서 발생하는 MCP(Model Context Protocol) 서버 프로세스의 고아화(Orphaning) 현상을 분석하고, 이에 대한 기술적 원인과 단계별 해결 방안을 제시한다. 분석 결과, 이는 Claude Code의 Windows 프로세스 트리 관리 버그와 MCP stdio 트랜스포트의 설계 특성이 결합된 문제로 확인되었다.

## 2. 문제 분석 (Root Cause)
### 2.1 Claude Code Windows 버그
- **현상**: 세션 종료(Exit) 시 MCP 자식 프로세스가 죽지 않고 백그라운드에서 계속 실행되어 CPU/메모리 자원을 점유함.
- **확인된 이슈**: GitHub Issues #1935, #15211, #28126, #11778, #29058, #30267.
- **기술적 원인**:
  - Linux/macOS는 **PGID(Process Group ID)**와 POSIX 시그널을 사용하여 프로세스 트리 전체를 신뢰성 있게 종료할 수 있음.
  - Windows는 POSIX 시그널 체계가 없으며, 부모 프로세스가 종료될 때 자식 프로세스를 자동으로 정리하는 메커니즘이 기본적으로 부족함.
  - Claude Code가 Windows 전용 프로세스 트리 종료 로직을 완벽하게 구현하지 못해 발생함.

### 2.2 triflux의 역할 및 한계
- triflux는 `hub/lib/process-utils.mjs`의 `cleanupOrphanNodeProcesses()`를 통해 5분마다 고아 프로세스를 정리하는 방어자 역할을 수행 중임.
- 그러나 현재 `KILLABLE_NAMES` 설정에 `python`, `serena`, `uv` 등 주요 MCP 실행 환경이 누락되어 있어 완벽한 정리가 이루어지지 않고 있음.

## 3. MCP 프로세스 모델
- **Stdio 트랜스포트 설계**: MCP 스펙상 `1 Process = 1 Session`이 기본 원칙임.
- **동작 방식**:
  - 세션이 시작될 때마다 새로운 MCP 프로세스가 `spawn`되는 것은 정상적인 설계임.
  - 세션 간 프로세스 재사용은 현재 MCP 스펙(2025-11-25 기준)에 정의되어 있지 않음.
  - `npx` 등은 패키지 캐시를 재사용할 뿐, 런타임 프로세스는 매번 새로 생성함.
- **결론**: 프로세스가 많이 생성되는 것 자체가 문제가 아니라, 종료 시 **정리되지 않는 것**이 핵심 문제임.

## 4. Windows 제약사항
Windows 환경에서 프로세스 트리를 강제 종료하는 데는 다음과 같은 기술적 제약이 존재함:
- **`taskkill /t`**: 트리 종료 옵션을 제공하지만 'Best Effort' 방식으로 작동하며, 모든 자식 프로세스의 종료를 보장하지 못함.
- **`Process.Kill(true)`**: .NET 등에서 제공하는 자식 포함 종료 기능은 비동기적 특성과 계층 깊이에 따른 동기화 누락 위험이 있음.
- **Job Object**: Windows에서 프로세스 그룹을 묶어 관리하고 부모 종료 시 자식을 확실히 죽일 수 있는 유일한 신뢰성 있는 커널 레벨 방법임.

## 5. 해결 방안 (Solutions)

### 5.1 즉시 해결 (Immediate)
- **Stop 훅 등록**: Claude Code의 세션 종료 훅(`Stop`)에 `mcp-cleanup.ps1` 스크립트를 등록함.
- **자동화**: triflux `setup.mjs`를 통해 설치 시 자동으로 훅이 등록되도록 조치 완료.

### 5.2 중기적 개선 (Mid-term)
- **커버리지 확장**: `hub/lib/process-utils.mjs`의 `KILLABLE_NAMES` 리스트에 `python`, `serena`, `uv`, `node` 등을 추가하여 triflux 허브의 고아 정리 범위를 넓힘.
- **cc-reaper 활용**: 커뮤니티 도구인 `cc-reaper`와 같은 전문 프로세스 관리 유틸리티의 도입 검토.

### 5.3 장기적 아키텍처 (Long-term)
- **트랜스포트 전환**: 불안정한 직접 stdio 클라이언트 연결 대신 gateway-backed HTTP MCP 트랜스포트로 전환.
- **Gateway 도입**: `supergateway` 등을 사용하여 MCP 서버를 영속적인 서비스 형태로 관리하고, Claude Code/Codex/Gemini/Antigravity는 클라이언트로서 접속만 수행하는 구조로 변경.
- **현재 표준**: gateway가 stdio upstream을 감싸야 하는 서버는 `gateway-http` 정책과 `/mcp` 경로를 사용한다. `supergateway`는 `--outputTransport streamableHttp --stateful --streamableHttpPath /mcp`로 실행한다.

### 5.4 SSE Gateway를 기본값으로 쓰지 않는 이유
- 기존 `gateway-sse`는 직접 stdio spawn을 줄이고 registry SSOT를 유지하기 위해 도입된 과도기적 형태였다. 설계 목적 자체는 여전히 유효하다.
- 그러나 `supergateway`의 stdio→SSE 래핑은 단일 stdio transport를 공유하는 형태라, 같은 포트에 두 번째 SSE GET/reconnect가 들어오면 `Already connected to a transport`로 gateway process가 종료될 수 있다.
- 따라서 해결 방향은 gateway daemon을 제거하거나 직접 stdio로 되돌리는 것이 아니라, 동일한 gateway daemon 경계 안에서 reconnect-safe한 stateful Streamable HTTP로 노출하는 것이다.
- `gateway-sse` 정책은 과거 설정을 읽기 위한 backward compatibility로만 남긴다. 신규 registry sync와 setup 안내는 `gateway-http`를 기본값으로 사용해야 한다.

## 6. 참고 자료
- **GitHub Issues**: #1935, #15211, #28126, #11778, #29058, #30267
- **MCP Transports Spec**: [https://modelcontextprotocol.io/specification/2025-11-25/basic/transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- **MS Job Objects**: [Windows Job Objects Documentation](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- **Claude Code Hooks**: [https://code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks)
- **Tools**: supergateway, cc-reaper
