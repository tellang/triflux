# mcp-gateway-start.ps1 — supergateway MCP SSE 영속 서비스 관리
# 각 MCP 서버를 supergateway로 래핑하여 SSE 엔드포인트로 노출한다.
# Usage: .\mcp-gateway-start.ps1          # 시작
#        .\mcp-gateway-start.ps1 -Stop    # 중지

param(
  [switch]$Stop
)

$PidFile = Join-Path $env:TEMP 'tfx-gateway-pids.json'

$Servers = @(
  @{ Name = 'context7';     Port = 8100; Cmd = 'npx -y @upstash/context7-mcp@latest';          EnvVars = @() }
  @{ Name = 'brave-search'; Port = 8101; Cmd = 'npx -y @brave/brave-search-mcp-server';        EnvVars = @('BRAVE_API_KEY') }
  @{ Name = 'exa';          Port = 8102; Cmd = 'npx -y exa-mcp-server';                        EnvVars = @('EXA_API_KEY') }
  @{ Name = 'tavily';       Port = 8103; Cmd = 'npx -y tavily-mcp@latest';                     EnvVars = @('TAVILY_API_KEY') }
  @{ Name = 'jira';         Port = 8104; Cmd = 'npx -y mcp-jira-cloud@latest';                 EnvVars = @('JIRA_API_TOKEN', 'JIRA_EMAIL', 'JIRA_INSTANCE_URL') }
  @{ Name = 'serena';       Port = 8105; Cmd = 'uvx --from git+https://github.com/oraios/serena serena start-mcp-server'; EnvVars = @() }
  @{ Name = 'notion';       Port = 8106; Cmd = 'npx -y @notionhq/notion-mcp-server';           EnvVars = @('NOTION_TOKEN') }
  @{ Name = 'notion-guest'; Port = 8107; Cmd = 'npx -y @notionhq/notion-mcp-server';           EnvVars = @('NOTION_TOKEN') }
)

function Test-PortInUse {
  param([int]$Port)
  try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $tcp.Connect('127.0.0.1', $Port)
    $tcp.Close()
    return $true
  }
  catch {
    return $false
  }
}

function Stop-AllGateways {
  # WMI CommandLine 기반 — PID 매니페스트 의존 제거 (F-02)
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" |
    Where-Object { $_.CommandLine -match 'supergateway' }

  if ($procs) {
    foreach ($p in $procs) {
      try {
        & taskkill /F /T /PID $p.ProcessId 2>$null | Out-Null
        Write-Host "[STOP] PID $($p.ProcessId)"
      }
      catch {
        Write-Host "[SKIP] PID $($p.ProcessId) — already gone"
      }
    }
  }
  else {
    Write-Host '[gateway] No supergateway processes found'
  }

  if (Test-Path $PidFile) {
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    Write-Host '[gateway] PID file removed'
  }
  Write-Host '[gateway] All gateways stopped'
}

function Start-AllGateways {
  $pidEntries = @()
  $started = 0

  foreach ($srv in $Servers) {
    $name = $srv.Name
    $port = $srv.Port

    # 포트 사용 중이면 스킵
    if (Test-PortInUse -Port $port) {
      Write-Host "[SKIP] $name already running on :$port"
      continue
    }

    # 필수 환경변수 체크
    $missing = @()
    foreach ($envKey in $srv.EnvVars) {
      if (-not [Environment]::GetEnvironmentVariable($envKey)) {
        $missing += $envKey
      }
    }
    if ($missing.Count -gt 0) {
      Write-Host "[WARN] $name skipped — missing env: $($missing -join ', ')"
      continue
    }

    # supergateway 기동 — npx는 .cmd 파일이므로 cmd.exe /c 로 래핑
    $stdioCmdEscaped = $srv.Cmd -replace '"', '\"'
    $sgCmd = "npx -y supergateway --stdio `"$stdioCmdEscaped`" --port $port --outputTransport sse --healthEndpoint /healthz"

    try {
      $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList "/c $sgCmd" `
        -WindowStyle Hidden -PassThru -ErrorAction Stop
      $pidEntries += @{ name = $name; port = $port; pid = $proc.Id }
      $started++
      Write-Host "[START] $name on :$port (PID $($proc.Id))"
    }
    catch {
      Write-Host "[ERROR] $name failed to start: $_"
    }
  }

  # PID 파일 저장
  if ($pidEntries.Count -gt 0) {
    $pidEntries | ConvertTo-Json -Depth 3 | Set-Content -Path $PidFile -Encoding UTF8
    Write-Host "`n[gateway] $started servers started. PID file: $PidFile"
  }
  else {
    Write-Host "`n[gateway] No servers started (all running or skipped)"
    return
  }

  # 헬스체크 (3초 대기 후)
  Write-Host "`n[gateway] Waiting 3s for startup..."
  Start-Sleep -Seconds 3

  Write-Host "`nHealth Check"
  Write-Host ('=' * 50)
  foreach ($entry in $pidEntries) {
    $url = "http://127.0.0.1:$($entry.port)/healthz"
    try {
      $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
      $status = if ($resp.StatusCode -eq 200) { 'ok' } else { 'error' }
      $mark = if ($status -eq 'ok') { [char]0x2713 } else { [char]0x2717 }
      Write-Host ("  {0,-16} :{1}  {2} {3}" -f $entry.name, $entry.port, $mark, $status)
    }
    catch {
      Write-Host ("  {0,-16} :{1}  {2} down" -f $entry.name, $entry.port, [char]0x2717)
    }
  }
}

# ── main ──
if ($Stop) {
  Stop-AllGateways
}
else {
  Start-AllGateways
}
