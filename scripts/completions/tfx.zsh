#compdef tfx
# Installation: fpath에 추가 후 compinit
# e.g., fpath=(/path/to/dir $fpath) && compinit

_tfx() {
    local state
    local -a commands hub_cmds multi_cmds swarm_cmds hooks_cmds

    commands=(
        'setup:Setup and sync files'
        'doctor:Diagnose CLI and issues'
        'mcp:MCP registry management'
        'update:Update triflux'
        'list:List installed skills'
        'ls:Alias for list'
        'handoff:Create handoff prompt'
        'schema:Print CLI and Hub schema'
        'hooks:Manage hook orchestrator'
        'hub:Hub process management'
        'tray:Start tray process'
        'multi:Multi-CLI team mode'
        'swarm:PRD worktree swarm'
        'synapse:Show swarm registry'
        'review:Codex diff review'
        'why:Show X-Intent trailer'
        'codex-team:Codex team mode'
        'notion-read:Read Notion page'
        'nr:Alias for notion-read'
        'monitor:Open TUI monitor'
        'version:Show version'
        'auto:Preview tfx-auto routing'
        'help:Show help'
    )

    hub_cmds=('start:Start hub' 'stop:Stop hub' 'status:Show hub status' 'ensure:Ensure hub is healthy' 'help:Show hub help')
    multi_cmds=('status:Show status' 'stop:Stop multi' 'kill:Kill multi' 'attach:Attach to multi' 'list:List sessions' 'help:Show multi help')
    swarm_cmds=('run:Run PRD swarm' 'preflight:Go/no-go report' 'plan:Plan only' 'list:List sessions' 'status:Alias for list' 'help:Show swarm help')
    hooks_cmds=('scan:Scan hooks' 'diff:Preview changes' 'apply:Apply orchestrator' 'restore:Restore hooks' 'status:Show status' 'set-priority:Set hook priority' 'toggle:Toggle hook' 'help:Show hooks help')

    _arguments -C \
        '1: :->cmds' \
        '*: :->args'

    case $state in
        cmds)
            _describe -t commands 'tfx commands' commands
            ;;
        args)
            case $words[2] in
                doctor)
                    _arguments \
                        '--fix[Auto fix issues]' \
                        '--reset[Reset caches]' \
                        '--audit[Run config audit]' \
                        '--diagnose[Create diagnostic bundle]' \
                        '--cleanup-stale-hubs[Report/cleanup stale hubs]' \
                        '--cleanup-stale-tmux[Report/cleanup stale tmux sessions]' \
                        '--dry-run[Preview cleanup]' \
                        '--apply[Apply cleanup]' \
                        '--json[JSON output]' \
                        '--help[Show help]'
                    ;;
                setup)
                    _arguments '--dry-run[Preview setup actions]' '--enable-hub-autostart[Register hub autostart]' '--help[Show help]'
                    ;;
                auto)
                    _arguments '--cli[Force lane: auto/codex/antigravity/claude]' '--mode[Mode: quick/deep/consensus]' '--parallel[Parallelism: 1/N/swarm]' '--json[JSON output]' '--help[Show help]'
                    ;;
                hub)
                    if (( CURRENT == 3 )) && [[ $words[CURRENT] != -* ]]; then
                        _describe -t hub_cmds 'hub commands' hub_cmds
                    else
                        _arguments '--port[Hub port]' '--json[JSON output]' '--help[Show help]'
                    fi
                    ;;
                multi)
                    if (( CURRENT == 3 )) && [[ $words[CURRENT] != -* ]]; then
                        _describe -t multi_cmds 'multi commands' multi_cmds
                    else
                        _arguments '--dashboard[Enable dashboard]' '--no-dashboard[Disable dashboard]' '--dashboard-layout[Dashboard layout]' '--json[JSON output]' '--help[Show help]'
                    fi
                    ;;
                swarm)
                    if (( CURRENT == 3 )) && [[ $words[CURRENT] != -* ]]; then
                        _describe -t swarm_cmds 'swarm commands' swarm_cmds
                    else
                        _arguments '--dry-run[Plan without execution]' '--json[JSON output]' '--filter[Shard filter]' '--max-restarts[Max restarts]' '--logs-dir[Logs directory]' '--help[Show help]'
                    fi
                    ;;
                hooks)
                    if (( CURRENT == 3 )) && [[ $words[CURRENT] != -* ]]; then
                        _describe -t hooks_cmds 'hooks commands' hooks_cmds
                    else
                        _arguments '--help[Show help]'
                    fi
                    ;;
                review)
                    _arguments '--base[Base ref]' '--timeout[Timeout seconds]' '--shard[Shard mode]' '--json[JSON output]' '--help[Show help]'
                    ;;
                *)
                    _arguments '--json[JSON output]' '--help[Show help]'
                    ;;
            esac
            ;;
    esac
}

_tfx "$@"
