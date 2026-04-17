# Issue #66 — `codex exec` MCP approval stall

- Triflux issue: [#66](https://github.com/tellang/triflux/issues/66)
- 상태: local guard는 존재하지만, oh-my-codex upstream fix 전까지 업데이트 후 재발 가능

## TL;DR

oh-my-codex 업데이트/재설치 후 `~/.codex/config.toml`의 일부 MCP tool 블록이 다시 `approval_mode = "approve"`로 돌아가면, `codex exec` subprocess가 MCP tool 승인 입력을 기다리다가 stall할 수 있다.

가장 안전한 복구 순서:

1. `~/.codex/config.toml`에서 `[mcp_servers.*.tools.*]` 블록의 `approval_mode = "approve"`를 `approval_mode = "auto"`로 되돌린다.
2. 다시 `codex exec`를 실행해 같은 프롬프트가 완료되는지 확인한다.
3. 급하면 `--dangerously-bypass-approvals-and-sandbox`로 즉시 우회한다.

## 증상

- `codex exec`가 출력 없이 오래 멈춘다.
- MCP tool 호출이 필요한 프롬프트에서 특히 재현된다.
- triflux wrapper 경로에서는 heartbeat가 `quiet` 또는 `STALL` 상태로 유지될 수 있다.
- 사용자가 승인 입력을 할 수 없는 non-TTY subprocess라서, 실제로는 tool approval 대기인데 그냥 hang처럼 보인다.

## 원인

문제는 top-level `approval_mode`가 아니라 **tool별 approval 설정**이다.

- 문제 위치: `~/.codex/config.toml`
- 문제 패턴: `[mcp_servers.*.tools.*]` 내부 `approval_mode = "approve"`
- 알려진 재발 조건: oh-my-codex 업데이트/재설치 후 해당 값이 다시 `approve`로 복원됨
- 알려진 사례: 최근 보고에서는 8개 MCP tool 블록이 동시에 복원됨

즉, `codex exec` 자체는 top-level auto/full-auto 설정과 별개로 동작하더라도, 실제 MCP tool 호출 단계에서 per-tool approval이 걸리면 subprocess가 interactive 승인을 기다리며 멈출 수 있다.

## 재현 시나리오

1. oh-my-codex를 업데이트하거나 재설치한다.
2. `~/.codex/config.toml`에서 `[mcp_servers.*.tools.*]` 블록의 `approval_mode`가 `approve`로 복원됐는지 확인한다.
3. MCP tool 사용이 필요한 `codex exec` 프롬프트를 실행한다.
4. 명령이 종료되지 않고 멈추는지 확인한다.

예시 확인 명령:

### Bash

```bash
grep -n 'approval_mode = "approve"' ~/.codex/config.toml
```

### PowerShell

```powershell
Select-String -Path "$HOME/.codex/config.toml" -Pattern 'approval_mode = "approve"'
```

위 명령이 MCP tool 섹션에서 여러 줄을 반환하고, 같은 시점에 `codex exec`가 끝나지 않으면 Issue #66 증상일 가능성이 높다.

## 검증 방법

### 1) 설정 오염 여부 확인

가장 빠른 진단:

```bash
node scripts/doctor-diagnose.mjs
```

이 스크립트는 다음과 같은 경고를 출력한다.

- `approval_mode="approve"` MCP tool 개수
- `codex exec non-TTY stall 위험`

직접 확인만 하고 싶다면:

### Bash

```bash
grep -n 'approval_mode = "approve"' ~/.codex/config.toml
```

### PowerShell

```powershell
Select-String -Path "$HOME/.codex/config.toml" -Pattern 'approval_mode = "approve"'
```

### 2) 복구 후 재검증

복구 후 같은 명령이 **아무 줄도 출력하지 않아야** 한다.

### Bash

```bash
grep -n 'approval_mode = "approve"' ~/.codex/config.toml
```

### PowerShell

```powershell
Select-String -Path "$HOME/.codex/config.toml" -Pattern 'approval_mode = "approve"'
```

그 다음, stall이 나던 동일한 `codex exec` 프롬프트를 다시 실행해 정상 종료를 확인한다.

## 복구 스크립트

아래 스크립트는 `[mcp_servers.*.tools.*]` 섹션 내부의 `approval_mode = "approve"`만 `auto`로 바꾸고, 수정 전 백업 파일을 만든다.

### Node.js 공통 복구 스크립트

```bash
node - <<'NODE'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const file = path.join(os.homedir(), '.codex', 'config.toml');
const src = fs.readFileSync(file, 'utf8').split(/\r?\n/);

let inToolBlock = false;
let changed = 0;

const out = src.map((line) => {
  const section = line.match(/^\[(.+)\]/);
  if (section) {
    inToolBlock = /^mcp_servers\..+\.tools\./.test(section[1]);
    return line;
  }
  if (inToolBlock && /^\s*approval_mode\s*=\s*"approve"/.test(line)) {
    changed += 1;
    return line.replace(/"approve"/, '"auto"');
  }
  return line;
});

if (!changed) {
  console.log('No MCP tool approval_mode=\"approve\" entries found.');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${file}.bak.${stamp}`;
fs.copyFileSync(file, backup);
fs.writeFileSync(file, out.join('\n'));

console.log(`Updated ${changed} MCP tool approval_mode entries.`);
console.log(`Backup: ${backup}`);
NODE
```

### PowerShell 복구 스크립트

```powershell
$file = Join-Path $HOME ".codex/config.toml"
$backup = "$file.bak.$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
$lines = Get-Content $file
$inToolBlock = $false
$changed = 0

$out = foreach ($line in $lines) {
  if ($line -match '^\[(.+)\]') {
    $inToolBlock = $Matches[1] -match '^mcp_servers\..+\.tools\.'
    $line
    continue
  }

  if ($inToolBlock -and $line -match '^\s*approval_mode\s*=\s*"approve"') {
    $changed++
    ($line -replace '"approve"', '"auto"')
    continue
  }

  $line
}

if ($changed -eq 0) {
  Write-Host 'No MCP tool approval_mode="approve" entries found.'
  return
}

Copy-Item $file $backup
Set-Content -Path $file -Value $out
Write-Host "Updated $changed MCP tool approval_mode entries."
Write-Host "Backup: $backup"
```

## 즉시 우회 방법

설정을 지금 바로 고치기 어렵다면, 다음처럼 bypass 플래그로 일단 진행할 수 있다.

```bash
codex exec "<prompt>" --dangerously-bypass-approvals-and-sandbox
```

주의:

- 이 플래그는 approval/sandbox를 모두 우회한다.
- 임시 복구용으로는 유효하지만, 반복 사용보다 config 정정이 더 안전하고 예측 가능하다.

## oh-my-codex 업데이트 후 재발 시 재적용

upstream fix가 아직 완전히 landed되지 않았다면, oh-my-codex 업데이트 후 같은 문제가 다시 생길 수 있다.

업데이트 직후 권장 체크리스트:

1. `node scripts/doctor-diagnose.mjs` 실행
2. `approval_mode="approve"` 경고가 있으면 복구 스크립트 재실행
3. stall이 나던 동일한 `codex exec` 프롬프트로 smoke test

반복 확인만 빠르게 하고 싶다면:

### Bash

```bash
grep -n 'approval_mode = "approve"' ~/.codex/config.toml
```

### PowerShell

```powershell
Select-String -Path "$HOME/.codex/config.toml" -Pattern 'approval_mode = "approve"'
```

출력이 다시 생기면, 복구 스크립트를 재적용하면 된다.

## 메모

- 이 문서는 local workaround 문서다.
- 근본 해결은 oh-my-codex upstream에서 tool approval 기본값/보존 로직이 수정되어야 닫힌다.
- triflux 쪽 local guard가 있더라도, direct `codex exec` 또는 guard가 적용되지 않은 경로에서는 같은 stall을 다시 만날 수 있다.
