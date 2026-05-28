# Installation: ~/.config/fish/completions/에 복사
# e.g., cp /path/to/tfx.fish ~/.config/fish/completions/tfx.fish

set -l commands setup doctor mcp update list ls handoff schema hooks hub tray multi swarm synapse review why codex-team notion-read nr monitor version auto help
set -l hub_cmds start stop status ensure help
set -l multi_cmds status stop kill attach list help
set -l swarm_cmds run preflight plan list status help
set -l hooks_cmds scan diff apply restore status set-priority toggle help

complete -c tfx -f

complete -c tfx -n "not __fish_seen_subcommand_from $commands" -a "setup" -d "Setup and sync files"
complete -c tfx -n "not __fish_seen_subcommand_from $commands" -a "doctor" -d "Diagnose CLI and issues"
complete -c tfx -n "not __fish_seen_subcommand_from $commands" -a "mcp" -d "MCP registry management"
complete -c tfx -n "not __fish_seen_subcommand_from $commands" -a "update" -d "Update triflux"
complete -c tfx -n "not __fish_seen_subcommand_from $commands" -a "list" -d "List installed skills"
complete -c tfx -n "not __fish_seen_subcommand_from $commands" -a "handoff" -d "Create handoff prompt"
complete -c tfx -n "not __fish_seen_subcommand_from $commands" -a "schema" -d "Print CLI and Hub schema"
complete -c tfx -n "not __fish_seen_subcommand_from $commands" -a "hooks" -d "Manage hook orchestrator"
complete -c tfx -n "not __fish_seen_subcommand_from $commands" -a "hub" -d "Hub process management"
complete -c tfx -n "not __fish_seen_subcommand_from $commands" -a "tray" -d "Start tray process"
complete -c tfx -n "not __fish_seen_subcommand_from $commands" -a "multi" -d "Multi-CLI team mode"
complete -c tfx -n "not __fish_seen_subcommand_from $commands" -a "swarm" -d "PRD worktree swarm"
complete -c tfx -n "not __fish_seen_subcommand_from $commands" -a "synapse" -d "Show swarm registry"
complete -c tfx -n "not __fish_seen_subcommand_from $commands" -a "review" -d "Codex diff review"
complete -c tfx -n "not __fish_seen_subcommand_from $commands" -a "why" -d "Show X-Intent trailer"
complete -c tfx -n "not __fish_seen_subcommand_from $commands" -a "codex-team" -d "Codex team mode"
complete -c tfx -n "not __fish_seen_subcommand_from $commands" -a "notion-read" -d "Read Notion page"
complete -c tfx -n "not __fish_seen_subcommand_from $commands" -a "monitor" -d "Open TUI monitor"
complete -c tfx -n "not __fish_seen_subcommand_from $commands" -a "version" -d "Show version"
complete -c tfx -n "not __fish_seen_subcommand_from $commands" -a "auto" -d "Preview tfx-auto routing"

complete -c tfx -n "__fish_seen_subcommand_from doctor" -l fix -d "Auto fix issues"
complete -c tfx -n "__fish_seen_subcommand_from doctor" -l reset -d "Reset caches"
complete -c tfx -n "__fish_seen_subcommand_from doctor" -l audit -d "Run config audit"
complete -c tfx -n "__fish_seen_subcommand_from doctor" -l diagnose -d "Create diagnostic bundle"
complete -c tfx -n "__fish_seen_subcommand_from doctor" -l cleanup-stale-hubs -d "Report/cleanup stale hubs"
complete -c tfx -n "__fish_seen_subcommand_from doctor" -l cleanup-stale-tmux -d "Report/cleanup stale tmux sessions"
complete -c tfx -n "__fish_seen_subcommand_from doctor" -l dry-run -d "Preview cleanup"
complete -c tfx -n "__fish_seen_subcommand_from doctor" -l apply -d "Apply cleanup"
complete -c tfx -n "__fish_seen_subcommand_from doctor" -l json -d "JSON output"

complete -c tfx -n "__fish_seen_subcommand_from setup" -l dry-run -d "Preview setup actions"
complete -c tfx -n "__fish_seen_subcommand_from setup" -l enable-hub-autostart -d "Register hub autostart"
complete -c tfx -n "__fish_seen_subcommand_from auto" -l cli -d "Force lane: auto/codex/antigravity/claude"
complete -c tfx -n "__fish_seen_subcommand_from auto" -l mode -d "Mode: quick/deep/consensus"
complete -c tfx -n "__fish_seen_subcommand_from auto" -l parallel -d "Parallelism: 1/N/swarm"
complete -c tfx -n "__fish_seen_subcommand_from auto" -l json -d "JSON output"

complete -c tfx -n "__fish_seen_subcommand_from hub; and not __fish_seen_subcommand_from $hub_cmds" -a "$hub_cmds"
complete -c tfx -n "__fish_seen_subcommand_from multi; and not __fish_seen_subcommand_from $multi_cmds" -a "$multi_cmds"
complete -c tfx -n "__fish_seen_subcommand_from swarm; and not __fish_seen_subcommand_from $swarm_cmds" -a "$swarm_cmds"
complete -c tfx -n "__fish_seen_subcommand_from hooks; and not __fish_seen_subcommand_from $hooks_cmds" -a "$hooks_cmds"

complete -c tfx -n "__fish_seen_subcommand_from review" -l base -d "Base ref"
complete -c tfx -n "__fish_seen_subcommand_from review" -l timeout -d "Timeout seconds"
complete -c tfx -n "__fish_seen_subcommand_from review" -l shard -d "Shard mode"
complete -c tfx -n "__fish_seen_subcommand_from review" -l json -d "JSON output"

complete -c tfx -n "__fish_seen_subcommand_from update tray list ls handoff schema synapse why codex-team notion-read nr monitor version" -l help -d "Show help"
complete -c tfx -n "__fish_seen_subcommand_from list ls handoff synapse review codex-team notion-read nr version" -l json -d "JSON output"
