#!/usr/bin/env bash
# Installation: source /path/to/tfx.bash 또는 ~/.bashrc에 추가

_tfx_completion() {
    local cur prev words cword
    COMPREPLY=()
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"
    words=("${COMP_WORDS[@]}")
    cword=$COMP_CWORD

    local commands="setup doctor mcp update list ls handoff schema hooks hub tray multi swarm synapse review why codex-team notion-read nr monitor version auto help"
    local doctor_flags="--fix --reset --audit --diagnose --purge-logs --dynamic-routing --cleanup-stale-hubs --cleanup-stale-tmux --prefix --age-min --dry-run --apply --json --help"
    local auto_flags="--cli --mode --parallel --json --help"
    local setup_flags="--dry-run --enable-hub-autostart --help"
    local hub_cmds="start stop status ensure help"
    local hub_flags="--port --json --help"
    local multi_cmds="status stop kill attach list help"
    local multi_flags="--dashboard --no-dashboard --dashboard-layout --json --help"
    local swarm_cmds="run preflight plan list status help"
    local swarm_flags="--dry-run --json --filter --max-restarts --logs-dir --help"
    local hooks_cmds="scan diff apply restore status set-priority toggle help"
    local review_flags="--base --timeout --shard --json --help"
    local schema_flags="--help"

    if [[ $cword -eq 1 ]]; then
        COMPREPLY=( $(compgen -W "${commands}" -- "$cur") )
        return 0
    fi

    local cmd="${words[1]}"
    case "${cmd}" in
        doctor)
            COMPREPLY=( $(compgen -W "${doctor_flags}" -- "$cur") )
            ;;
        auto)
            COMPREPLY=( $(compgen -W "${auto_flags}" -- "$cur") )
            ;;
        setup)
            COMPREPLY=( $(compgen -W "${setup_flags}" -- "$cur") )
            ;;
        hub)
            if [[ $cword -eq 2 && ! "$cur" == -* ]]; then
                COMPREPLY=( $(compgen -W "${hub_cmds}" -- "$cur") )
            else
                COMPREPLY=( $(compgen -W "${hub_flags}" -- "$cur") )
            fi
            ;;
        multi)
            if [[ $cword -eq 2 && ! "$cur" == -* ]]; then
                COMPREPLY=( $(compgen -W "${multi_cmds}" -- "$cur") )
            else
                COMPREPLY=( $(compgen -W "${multi_flags}" -- "$cur") )
            fi
            ;;
        swarm)
            if [[ $cword -eq 2 && ! "$cur" == -* ]]; then
                COMPREPLY=( $(compgen -W "${swarm_cmds}" -- "$cur") )
            else
                COMPREPLY=( $(compgen -W "${swarm_flags}" -- "$cur") )
            fi
            ;;
        hooks)
            if [[ $cword -eq 2 && ! "$cur" == -* ]]; then
                COMPREPLY=( $(compgen -W "${hooks_cmds}" -- "$cur") )
            fi
            ;;
        review)
            COMPREPLY=( $(compgen -W "${review_flags}" -- "$cur") )
            ;;
        schema)
            COMPREPLY=( $(compgen -W "${commands} delegate delegate-reply status ${schema_flags}" -- "$cur") )
            ;;
        update|list|ls|handoff|tray|synapse|why|codex-team|notion-read|nr|monitor|version)
            COMPREPLY=( $(compgen -W "--json --help" -- "$cur") )
            ;;
    esac
}

complete -F _tfx_completion tfx
