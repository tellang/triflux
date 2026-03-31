# Stop all MCP singleton daemons
# Usage: powershell -ExecutionPolicy Bypass -File stop-daemons.ps1

9001..9005 | ForEach-Object {
    $port = $_
    $conn = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    if ($conn) {
        $pid = $conn[0].OwningProcess
        Write-Host "[STOP] Killing PID $pid on port $port"
        Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host "[SKIP] Nothing on port $port"
    }
}
Write-Host "All MCP daemons stopped."
