# MCP Singleton Daemons - supergateway wrapper
# Each OMX MCP server runs once, codex sessions connect via mcp-remote
# Usage: powershell -ExecutionPolicy Bypass -File start-daemons.ps1

$OMX_BASE = "$env:APPDATA/npm/node_modules/oh-my-codex/dist/mcp"
$SG_CMD = "$env:APPDATA\npm\supergateway.cmd"
$DAEMON_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path

$servers = @(
    @{ Name = "omx_state";      Script = "state-server.js";      Port = 9001 }
    @{ Name = "omx_memory";     Script = "memory-server.js";     Port = 9002 }
    @{ Name = "omx_code_intel"; Script = "code-intel-server.js"; Port = 9003 }
    @{ Name = "omx_trace";      Script = "trace-server.js";      Port = 9004 }
    @{ Name = "omx_team_run";   Script = "team-server.js";       Port = 9005 }
)

foreach ($srv in $servers) {
    $port = $srv.Port
    $name = $srv.Name
    $script = "$OMX_BASE/$($srv.Script)"

    # Check if already running on this port
    $existing = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "[SKIP] $name already running on port $port"
        continue
    }

    # Create individual launcher .cmd
    $launcher = Join-Path $DAEMON_DIR "run-$name.cmd"
    $content = "@echo off`r`ncall `"$SG_CMD`" --stdio `"node $script`" --port $port"
    Set-Content -Path $launcher -Value $content -Encoding ASCII

    Write-Host "[START] $name on port $port"
    Start-Process -WindowStyle Hidden -FilePath $launcher

    Start-Sleep -Milliseconds 800
}

Start-Sleep -Milliseconds 1000

# Verify
$ok = 0
foreach ($srv in $servers) {
    $c = Get-NetTCPConnection -LocalPort $srv.Port -ErrorAction SilentlyContinue
    if ($c) {
        Write-Host "[OK] $($srv.Name) listening on port $($srv.Port)"
        $ok++
    } else {
        Write-Host "[FAIL] $($srv.Name) NOT listening on port $($srv.Port)"
    }
}
Write-Host ""
Write-Host "$ok / $($servers.Count) daemons running"
