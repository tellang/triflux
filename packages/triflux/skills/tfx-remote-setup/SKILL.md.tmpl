---
name: tfx-remote-setup
description: >
  원격 호스트 설정 위저드. AskUserQuestion 기반 인터랙티브 UI로
  Tailscale 네트워크 감지, SSH 연결 확인, Claude 설치 프로브, hosts.json 관리를 수행합니다.
  Use when: remote setup, 원격 설정, 호스트 추가, hosts.json, 원격 환경, remote config,
  tailscale, 테일스케일
triggers:
  - tfx-remote-setup
argument-hint: "[--add|--edit|--probe-all|--diagnose]"
---

# tfx-remote-setup — 원격 호스트 설정 위저드

> **ARGUMENTS 처리**: 이 스킬이 `ARGUMENTS: <값>`과 함께 호출되면, 해당 값을 사용자 입력으로 취급하여
> 워크플로우의 첫 단계 입력으로 사용한다. ARGUMENTS가 비어있거나 없으면 기존 절차대로 사용자에게 입력을 요청한다.


> 원격 세션(tfx-remote-spawn)을 쓰기 전에 호스트를 설정합니다.
> Tailscale 네트워크 자동 감지 → SSH 연결 → Claude 프로브 → hosts.json 등록을 한번에.

## 워크플로우

### Step 1: 모드 선택 (AskUserQuestion)

인자 없이 호출된 경우:

```
question: "어떤 설정을 하시겠습니까?"
header: "원격 설정"
options:
  - label: "새 호스트 추가 (Add)"
    description: "Tailscale 감지 → SSH 연결 → Claude 프로브 → hosts.json 등록"
  - label: "기존 호스트 편집 (Edit)"
    description: "별칭, 기본 디렉토리, 설명 수정"
  - label: "전체 프로브 (Probe All)"
    description: "등록된 모든 호스트 환경을 일괄 점검"
  - label: "진단 (Diagnose)"
    description: "Tailscale, SSH, psmux, WT, hosts.json 전체 상태 확인"
```

`--add` → 바로 호스트 추가 플로우.
`--edit` → 바로 편집 플로우.
`--probe-all` → 바로 전체 프로브.
`--diagnose` → 바로 진단.

### Step 2: 모드별 실행

#### 새 호스트 추가 (Add)

**2-1. Tailscale 네트워크 감지**

먼저 Tailscale tailnet의 피어 목록을 조회한다:

```bash
tailscale status --json 2>/dev/null
```

Tailscale이 설치되어 있고 로그인 상태이면, 피어 목록에서 호스트를 AskUserQuestion으로 표시:

```
question: "Tailscale 네트워크에서 호스트가 감지되었습니다. 선택하세요."
header: "Tailscale 피어"
options:
  - label: "ultra4 (100.x.x.x)"
    description: "Windows | online | ultra4.yak-bebop.ts.net"
  - label: "m2 (100.y.y.y)"
    description: "macOS | online | m2.yak-bebop.ts.net"
  - label: "SSH config에서 선택"
    description: "Tailscale 대신 ~/.ssh/config에서 호스트 선택"
  - label: "직접 입력"
    description: "호스트명을 수동 입력"
```

옵션은 `tailscale status --json`에서 동적 생성. 피어별로 HostName, TailscaleIPs[0], OS, Online 상태를 파싱.

**피어 IP 추출 명령어:**
```bash
# 특정 호스트 IPv4
tailscale status --json | jq -r '.Peer[] | select(.HostName == "{host}") | .TailscaleIPs[0]'

# 전체 hostname → IPv4 맵
tailscale status --json | jq '[.Self] + [.Peer[]] | map({(.DNSName | split(".")[0]): (.TailscaleIPs[0])}) | add'
```

**PowerShell 대체:**
```powershell
$ts = tailscale status --json | ConvertFrom-Json
$ts.Peer.PSObject.Properties.Value | Select-Object HostName, @{N='IP';E={$_.TailscaleIPs[0]}}, Online
```

Tailscale 미설치 또는 미로그인 → SSH config 선택으로 fallback:

```
question: "SSH config에서 호스트를 선택하거나 직접 입력하세요"
header: "SSH 호스트"
options:
  - label: "ultra4"
    description: "192.168.0.10 (SSH config)"
  - label: "m2"
    description: "100.x.x.x (SSH config)"
  - label: "직접 입력"
    description: "SSH config에 없는 호스트를 수동 입력"
```

옵션은 `~/.ssh/config`에서 동적 생성. hosts.json에 이미 등록된 호스트는 `(등록됨)` 표시.

**2-2. 연결 방식 선택**

Tailscale 피어를 선택한 경우, 연결 방식을 결정한다:

```
question: "어떤 SSH 연결 방식을 사용하시겠습니까?"
header: "연결 방식"
options:
  - label: "Tailscale SSH (Recommended)"
    description: "SSH 키 불필요 — Tailscale identity로 인증. tailscale set --ssh 필요"
  - label: "SSH over Tailscale VPN"
    description: "기존 OpenSSH 사용 — Tailscale은 터널만 제공. SSH 키/비밀번호 필요"
  - label: "MagicDNS + ProxyCommand"
    description: "tailscale nc ProxyCommand 사용 — NAT 환경에서 안정적"
```

**각 방식의 차이:**

| 방식 | 인증 | SSH 키 필요 | known_hosts | 제약 |
|------|------|-------------|-------------|------|
| Tailscale SSH | Tailscale identity (WireGuard 노드 키) | 아니오 | 자동 관리 | 서버측 `tailscale set --ssh` + ACL 필요 |
| SSH over VPN | OpenSSH 표준 | 예 | 수동 관리 | 100.x.x.x IP 직접 사용 |
| MagicDNS + nc | OpenSSH + tailscale nc | 예 | 수동 관리 | ProxyCommand 설정 |

**Tailscale SSH 선택 시 — 서버 설정 안내:**

원격 호스트에서 Tailscale SSH를 활성화해야 한다:

```bash
# 원격 호스트에서 실행
tailscale set --ssh
```

**플랫폼별 주의사항:**
- **macOS**: App Store 버전은 샌드박스 제한으로 Tailscale SSH 서버 불가 → **Homebrew/standalone CLI 버전** 필요 (`brew install tailscale`)
- **Windows**: Tailscale SSH 서버 **미지원** (클라이언트만 가능) → "SSH over Tailscale VPN" 사용
- **Linux**: 제한 없음

원격 호스트가 Windows인 경우 자동으로 "SSH over Tailscale VPN"으로 전환:
```
"대상이 Windows입니다. Tailscale SSH 서버는 Windows에서 미지원 →
 SSH over Tailscale VPN 모드로 전환합니다."
```

원격 호스트가 macOS인 경우 확인:
```
question: "macOS에서 Tailscale SSH를 사용하려면 Homebrew 버전이 필요합니다. 확인되었습니까?"
header: "macOS Tailscale"
options:
  - label: "Homebrew 버전 사용 중"
    description: "brew install tailscale로 설치됨"
  - label: "App Store 버전 사용 중"
    description: "SSH over Tailscale VPN으로 전환"
  - label: "모르겠음"
    description: "SSH over Tailscale VPN으로 전환 (안전한 선택)"
```

**2-3. SSH config 자동 생성**

선택한 연결 방식에 따라 `~/.ssh/config` 엔트리를 생성/갱신한다.

**Tailscale SSH:**
```ssh-config
Host {host}
    HostName {host}.{tailnet-name}.ts.net
    # Tailscale SSH — 키 불필요, identity 자동 인증
```

**SSH over Tailscale VPN (MagicDNS 사용 — 권장):**
```ssh-config
Host {host}
    HostName {host}.{tailnet-name}.ts.net
    User {username}
    IdentityFile ~/.ssh/id_ed25519
```

> **MagicDNS 호스트명 사용 권장.** `100.x.y.z` IP는 CGNAT 범위로 보통 안정적이지만,
> 노드 삭제 후 재등록 시 변경될 수 있다. MagicDNS(`{host}.{tailnet}.ts.net`)는 항상 현재 IP로 해석된다.

**MagicDNS + ProxyCommand:**
```ssh-config
Host {host}
    HostName {host}.{tailnet-name}.ts.net
    User {username}
    ProxyCommand tailscale nc %h %p
    IdentityFile ~/.ssh/id_ed25519
```

SSH config 갱신 여부 확인:
```
question: "SSH config에 {host} 엔트리를 추가/갱신하시겠습니까?"
header: "SSH Config"
options:
  - label: "추가 (Recommended)"
    description: "{연결 방식} 설정을 ~/.ssh/config에 추가"
  - label: "기존 엔트리 유지"
    description: "이미 설정된 SSH config를 그대로 사용"
  - label: "건너뛰기"
    description: "SSH config 수정 없이 진행"
```

**2-4. SSH 연결 테스트**

```bash
ssh -o ConnectTimeout=5 -o BatchMode=yes {host} "echo ok" 2>&1
```

| 결과 | 동작 |
|------|------|
| ok | 다음 단계 |
| 실패 | 에러 메시지 표시 + AskUserQuestion ↓ |

```
question: "{host} SSH 연결에 실패했습니다. 어떻게 하시겠습니까?"
header: "SSH 실패"
options:
  - label: "Tailscale IP 갱신"
    description: "tailscale status로 최신 IP 조회 후 SSH config 갱신"
  - label: "Tailscale SSH 활성화 안내"
    description: "원격 호스트에서 tailscale set --ssh 실행 가이드"
  - label: "다른 호스트로 재시도"
    description: "호스트 선택 메뉴로 돌아감"
  - label: "취소"
    description: "설정 중단"
```

**Tailscale IP 갱신 선택 시:**
```bash
# 해당 호스트의 최신 IP 조회
tailscale status --json | jq -r '.Peer[] | select(.HostName == "{host}") | .TailscaleIPs[0]'
```
결과를 표시하고, SSH config의 HostName을 MagicDNS로 갱신:
```
"{host}의 Tailscale IP: 100.x.x.x
 MagicDNS: {host}.{tailnet}.ts.net
 → SSH config HostName을 MagicDNS로 갱신합니다."
```

**2-5. 원격 환경 프로브**

```bash
node scripts/remote-spawn.mjs --probe {host}
```

결과를 표시:
```
{host} 환경:
  OS: {os}
  Shell: {shell}
  Home: {home}
  Claude: {claudePath || "미설치"}
  Node: {nodeVersion}
  Tailscale SSH: {enabled/disabled/unknown}
```

Claude 미설치 시 AskUserQuestion:
```
question: "Claude Code가 설치되어 있지 않습니다. 어떻게 하시겠습니까?"
header: "Claude 미설치"
options:
  - label: "원격 설치 실행"
    description: "SSH로 npm install -g @anthropic-ai/claude-code 실행"
  - label: "설치 없이 등록"
    description: "hosts.json에 등록만 (나중에 수동 설치)"
  - label: "취소"
    description: "이 호스트 등록 중단"
```

원격 설치 선택 시:
```bash
ssh {host} "npm install -g @anthropic-ai/claude-code"
```
설치 후 다시 프로브하여 확인.

**2-6. 호스트 정보 입력**

AskUserQuestion으로 순차 수집:

```
question: "이 호스트의 표시 이름(설명)을 입력하세요"
header: "설명"
defaultValue: "{host}"
```

```
question: "한글 별칭을 입력하세요 (쉼표로 구분, 예: 맥북,맥)"
header: "별칭"
defaultValue: ""
```

```
question: "기본 작업 디렉토리를 입력하세요"
header: "디렉토리"
defaultValue: "~/projects"
```

**2-7. hosts.json 저장**

`skills/tfx-remote-spawn/references/hosts.json`을 Read → Edit:

- 파일이 없으면 새로 생성 (기본 구조)
- 파일이 있으면 hosts 객체에 새 호스트 추가

```json
{
  "hosts": {
    "{host}": {
      "description": "{description}",
      "aliases": ["{alias1}", "{alias2}"],
      "default_dir": "{default_dir}",
      "tailscale": {
        "ip": "100.x.x.x",
        "dns": "{host}.{tailnet}.ts.net",
        "ssh_mode": "tailscale-ssh | ssh-over-vpn | magicdns-nc"
      }
    }
  },
  "default_host": "{host}",
  "triggers": ["원격에서", "다른 머신에서", "다른 컴퓨터에서"]
}
```

첫 호스트면 default_host로 자동 설정.
2번째 이상이면 AskUserQuestion:
```
question: "이 호스트를 기본 호스트로 설정하시겠습니까?"
header: "기본 호스트"
options:
  - label: "예 — {host}를 기본으로"
    description: "호스트명 생략 시 이 호스트 사용"
  - label: "아니오 — 기존 유지 ({current_default})"
    description: "현재 기본 호스트 유지"
```

저장 후 결과 보고.

**2-8. MCP 고아 프로세스 정리 훅 배포 (Windows 원격 호스트)**

원격 호스트가 Windows인 경우, MCP 고아 프로세스 정리 훅을 자동 배포한다.
Claude Code 세션 종료 시 MCP 서버 프로세스가 정리되지 않는 Windows 고유 버그 대응.
(GitHub Issues #1935, #15211, #28126)

```bash
# mcp-cleanup.ps1 배포
scp "$(npm root -g)/triflux/scripts/mcp-cleanup.ps1" {host}:~/.claude/scripts/mcp-cleanup.ps1
```

배포 후 원격 호스트의 `~/.claude/settings.json`에 Stop 훅을 등록한다:

```bash
ssh {host} "node -e \"
  const fs = require('fs');
  const p = require('path').join(require('os').homedir(), '.claude', 'settings.json');
  const s = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!s.hooks) s.hooks = {};
  if (!Array.isArray(s.hooks.Stop)) s.hooks.Stop = [];
  const has = s.hooks.Stop.some(e => e.hooks?.some(h => h.command?.includes('mcp-cleanup')));
  if (!has) {
    const script = require('path').join(require('os').homedir(), '.claude/scripts/mcp-cleanup.ps1').replace(/\\\\\\\\/g, '/');
    const entry = s.hooks.Stop.find(e => e.matcher === '*' && Array.isArray(e.hooks));
    const hook = { type: 'command', command: 'powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \\\"' + script + '\\\"', timeout: 8 };
    if (entry) entry.hooks.push(hook); else s.hooks.Stop.push({ matcher: '*', hooks: [hook] });
    fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\\n');
    console.log('mcp-cleanup hook registered');
  } else { console.log('mcp-cleanup hook already exists'); }
\""
```

macOS/Linux 원격 호스트에서는 이 단계를 건너뛴다 (PGID 기반 kill이 정상 동작).

프로브 결과에서 OS를 확인하여 자동 판단:
- Windows → 배포 실행
- macOS/Linux → 건너뛰기 (표시만)

```
"{host}는 Windows입니다. MCP 고아 프로세스 정리 훅을 배포합니다."
```

**2-9. 후속 작업**

```
question: "호스트가 등록되었습니다. 추가 작업이 있습니까?"
header: "다음"
options:
  - label: "다른 호스트도 추가"
    description: "호스트 추가 플로우 반복"
  - label: "세션 spawn 테스트"
    description: "/tfx-remote-spawn으로 세션 생성 테스트"
  - label: "완료"
    description: "설정 종료"
```

#### 기존 호스트 편집 (Edit)

`references/hosts.json`을 읽어 등록된 호스트 목록을 AskUserQuestion으로 표시:

```
question: "어떤 호스트를 편집하시겠습니까?"
header: "호스트"
options:
  - label: "ultra4"
    description: "Windows 데스크탑 (SSAFY) | 별칭: 울트라, 데스크탑 | tailscale-ssh"
  - label: "m2"
    description: "MacBook Pro | 별칭: 맥북, 맥 | ssh-over-vpn"
  - label: "호스트 삭제"
    description: "등록된 호스트를 제거"
```

호스트 선택 후 편집 항목 선택:

```
question: "무엇을 수정하시겠습니까?"
header: "편집"
multiSelect: true
options:
  - label: "설명"
    description: "현재: {description}"
  - label: "별칭"
    description: "현재: {aliases}"
  - label: "기본 디렉토리"
    description: "현재: {default_dir}"
  - label: "SSH 연결 방식"
    description: "현재: {ssh_mode} → 변경"
  - label: "Tailscale IP 갱신"
    description: "tailscale status로 최신 IP/DNS 조회"
  - label: "기본 호스트로 설정"
    description: "현재 기본: {default_host}"
```

선택된 항목에 대해 순차 AskUserQuestion으로 새 값 입력받아 Edit 도구로 hosts.json 수정.

#### 전체 프로브 (Probe All)

등록된 모든 호스트를 순회하며 프로브:

```bash
node scripts/remote-spawn.mjs --probe {host}
```

결과를 종합 테이블로 표시:

```
| 호스트 | OS | SSH 방식 | Claude | Tailscale | 상태 |
|--------|----|----------|--------|-----------|------|
| ultra4 | Windows | ssh-over-vpn | v1.x.x | online (100.x.x.x) | ✅ |
| m2 | macOS | tailscale-ssh | 미설치 | online (100.y.y.y) | ⚠ |
```

이슈가 있는 호스트가 있으면 AskUserQuestion:
```
question: "이슈가 있는 호스트가 있습니다. 어떻게 하시겠습니까?"
header: "이슈"
options:
  - label: "이슈 호스트 수정"
    description: "{host}: Claude 미설치 → 원격 설치 시도"
  - label: "Tailscale IP 일괄 갱신"
    description: "모든 호스트의 Tailscale IP/DNS를 최신으로 갱신"
  - label: "무시하고 계속"
    description: "이슈를 확인만 하고 넘어감"
```

#### 진단 (Diagnose)

전체 환경을 점검하고 테이블로 보고:

```
| 항목 | 상태 | 비고 |
|------|------|------|
| Tailscale | ✅ | 로그인됨, tailnet: yak-bebop |
| hosts.json | ✅ | 2개 호스트 등록 |
| SSH config | ✅ | ultra4, m2 존재 |
| psmux | ✅ | 설치됨 |
| Windows Terminal | ✅ | 감지됨 |
| 원격 캐시 | ✅ | .omc/state/remote-env/ |
```

점검 항목:
1. **Tailscale 상태** — `tailscale status` 실행, 로그인/tailnet 이름/피어 수
2. `references/hosts.json` 존재 및 유효성
3. `~/.ssh/config`에 hosts.json 호스트들 등록 여부 (MagicDNS 사용 여부)
4. Tailscale IP와 SSH config HostName 일치 여부
5. psmux 설치 여부 (`hub/team/psmux.mjs` 존재)
6. Windows Terminal 감지
7. `.omc/state/remote-env/` 캐시 상태 (TTL 만료 여부)
8. `remoteControlAtStartup` 설정 여부

이슈 발견 시 AskUserQuestion:
```
question: "N개 이슈가 발견되었습니다. 자동 수정을 시도하시겠습니까?"
header: "수정"
options:
  - label: "자동 수정 (Recommended)"
    description: "가능한 이슈를 자동으로 해결"
  - label: "수동 확인"
    description: "이슈별로 하나씩 확인"
  - label: "건너뛰기"
    description: "진단 결과만 확인"
```

### Step 3: 완료 후 후속 작업

```
question: "다른 설정 작업을 하시겠습니까?"
header: "계속"
options:
  - label: "다른 모드 실행"
    description: "추가/편집/프로브/진단 메뉴로 돌아감"
  - label: "원격 세션 시작"
    description: "/tfx-remote-spawn으로 세션 생성"
  - label: "종료"
    description: "설정 완료"
```

## Tailscale 참조

### 100.x.y.z IP 안정성

Tailscale의 CGNAT 주소(100.x.y.z)는 **영구적으로 안정**하다.
네트워크 이동, 재부팅, VPN 재연결에도 변경되지 않는다.
변경되는 경우: 노드를 tailnet에서 삭제 후 재등록, IP pool 변경, Tailscale 재설치.

그럼에도 **MagicDNS 호스트명 사용을 권장**한다 — IP가 변경되어도 DNS가 자동 추적.

### 플랫폼별 Tailscale SSH 지원

| 플랫폼 | SSH 클라이언트 | SSH 서버 | 비고 |
|--------|---------------|----------|------|
| Linux | ✅ | ✅ | 제한 없음 |
| macOS (Homebrew) | ✅ | ✅ | `brew install tailscale` |
| macOS (App Store) | ✅ | ❌ | 샌드박스 제한 |
| Windows | ✅ | ❌ | 클라이언트만 가능 |

### Tailscale SSH 활성화 (서버측)

```bash
# 서버에서 실행
tailscale set --ssh

# ACL policy에도 ssh 블록 필요 (admin console에서):
# {
#   "ssh": [{
#     "action": "accept",
#     "src": ["autogroup:member"],
#     "dst": ["autogroup:self"],
#     "users": ["autogroup:nonroot", "root"]
#   }]
# }
```

## 에러 처리

| 상황 | 처리 |
|------|------|
| Tailscale 미설치 | SSH config fallback, 설치 안내 |
| Tailscale 미로그인 | `tailscale login` 안내 |
| SSH config 없음 | 생성 가이드 출력 |
| SSH 연결 실패 | Tailscale IP 갱신 / MagicDNS 전환 안내 |
| macOS App Store Tailscale | SSH over VPN으로 자동 전환 |
| Windows 서버 대상 | SSH over VPN으로 자동 전환 |
| hosts.json 파싱 실패 | 백업 생성 후 새로 작성 |
| 원격 npm 없음 | Node.js 설치 안내 |
| psmux 미설치 | WT+SSH fallback 안내 |

## 전제 조건

- SSH 클라이언트 (ssh 명령어)
- `scripts/remote-spawn.mjs` 설치됨 (`triflux setup` 자동)
- (권장) Tailscale — 네트워크 자동 감지 + MagicDNS
- (권장) psmux, Windows Terminal
