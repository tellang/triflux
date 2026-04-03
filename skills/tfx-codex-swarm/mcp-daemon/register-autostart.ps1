# Register MCP daemon auto-start via Task Scheduler
# Runs start-daemons.ps1 at user logon so daemons survive WT crashes/reboots
# Usage: powershell -ExecutionPolicy Bypass -File register-autostart.ps1

$taskName = "OMX-MCP-Daemons"
$scriptPath = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "start-daemons.ps1"

# Remove existing task if any
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Start OMX MCP singleton daemons (supergateway on ports 9001-9005)" `
    -RunLevel Limited

Write-Host "[OK] Task '$taskName' registered. Daemons will auto-start at logon."
Write-Host "     Manual run: schtasks /Run /TN $taskName"
