# mcp-cleanup.ps1 — Claude Code Stop hook: MCP 고아 프로세스 정리
# Windows에서 Claude Code 세션 종료 시 남는 MCP 서버 고아 프로세스를 정리한다.
# 원인: Claude Code가 stdio MCP 자식 프로세스 트리를 Windows에서 제대로 kill하지 못함
#       (GitHub Issues #1935, #15211, #28126)
$ErrorActionPreference = 'SilentlyContinue'

# npx MCP servers (brave, notion, context7, exa, tavily, jira, playwright, etc.)
# + oh-my-codex MCP servers (team/code-intel/memory/trace/state)
# + omc bridge
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" |
  Where-Object { $_.CommandLine -match 'npx-cli|oh-my-codex[\\/]dist[\\/]mcp|omc.*bridge.*mcp-server' } |
  ForEach-Object { taskkill /F /PID $_.ProcessId 2>$null }

# serena (uvx) + python MCP orphans
Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='uvx.exe'" |
  Where-Object { $_.CommandLine -match 'serena|uv[\\/](cache|python)' } |
  ForEach-Object { taskkill /F /PID $_.ProcessId 2>$null }
