# Installation: ~/.config/fish/completions/에 복사
# e.g., cp /path/to/tfx.fish ~/.config/fish/completions/tfx.fish

set -l commands setup doctor multi hub auto codex gemini
set -l multi_cmds status stop kill attach list
set -l hub_cmds start stop status restart

complete -c tfx -f

# Subcommands
complete -c tfx -n "not __fish_seen_subcommand_from $commands" -a "setup" -d "Setup and sync files"
complete -c tfx -n "not __fish_seen_subcommand_from $commands" -a "doctor" -d "Diagnose CLI and issues"
complete -c tfx -n "not __fish_seen_subcommand_from $commands" -a "multi" -d "Multi-CLI team mode"
complete -c tfx -n "not __fish_seen_subcommand_from $commands" -a "hub" -d "MCP message bus management"
complete -c tfx -n "not __fish_seen_subcommand_from $commands" -a "auto" -d "Auto mode"
complete -c tfx -n "not __fish_seen_subcommand_from $commands" -a "codex" -d "Codex mode"
complete -c tfx -n "not __fish_seen_subcommand_from $commands" -a "gemini" -d "Gemini mode"

# Doctor flags
complete -c tfx -n "__fish_seen_subcommand_from doctor" -l fix -d "Auto fix issues"
complete -c tfx -n "__fish_seen_subcommand_from doctor" -l reset -d "Reset all caches"

# Multi subcommands
complete -c tfx -n "__fish_seen_subcommand_from multi; and not __fish_seen_subcommand_from $multi_cmds" -a "status"
complete -c tfx -n "__fish_seen_subcommand_from multi; and not __fish_seen_subcommand_from $multi_cmds" -a "stop"
complete -c tfx -n "__fish_seen_subcommand_from multi; and not __fish_seen_subcommand_from $multi_cmds" -a "kill"
complete -c tfx -n "__fish_seen_subcommand_from multi; and not __fish_seen_subcommand_from $multi_cmds" -a "attach"
complete -c tfx -n "__fish_seen_subcommand_from multi; and not __fish_seen_subcommand_from $multi_cmds" -a "list"

# Hub subcommands
complete -c tfx -n "__fish_seen_subcommand_from hub; and not __fish_seen_subcommand_from $hub_cmds" -a "start"
complete -c tfx -n "__fish_seen_subcommand_from hub; and not __fish_seen_subcommand_from $hub_cmds" -a "stop"
complete -c tfx -n "__fish_seen_subcommand_from hub; and not __fish_seen_subcommand_from $hub_cmds" -a "status"
complete -c tfx -n "__fish_seen_subcommand_from hub; and not __fish_seen_subcommand_from $hub_cmds" -a "restart"

# Global or multi flags
set -l flags_cond "__fish_seen_subcommand_from setup multi auto codex gemini"
complete -c tfx -n "$flags_cond" -l thorough -d "Thorough execution"
complete -c tfx -n "$flags_cond" -l quick -d "Quick execution"
complete -c tfx -n "$flags_cond" -l tmux -d "Use tmux"
complete -c tfx -n "$flags_cond" -l psmux -d "Use psmux"
complete -c tfx -n "$flags_cond" -l agents -d "Specify agents"
complete -c tfx -n "$flags_cond" -l no-attach -d "Do not attach"
complete -c tfx -n "$flags_cond" -l timeout -d "Set timeout"
