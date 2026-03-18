#!/usr/bin/env bash
# Installation: source /path/to/tfx.bash 또는 ~/.bashrc에 추가

_tfx_completion() {
    local cur prev words cword
    COMPREPLY=()
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"
    words=("${COMP_WORDS[@]}")
    cword=$COMP_CWORD

    local commands="setup doctor multi hub auto codex gemini"
    local multi_cmds="status stop kill attach list"
    local hub_cmds="start stop status restart"
    local flags="--thorough --quick --tmux --psmux --agents --no-attach --timeout"

    if [[ $cword -eq 1 ]]; then
        COMPREPLY=( $(compgen -W "${commands}" -- "$cur") )
        return 0
    fi

    local cmd="${words[1]}"
    case "${cmd}" in
        multi)
            if [[ $cword -eq 2 && ! "$cur" == -* ]]; then
                COMPREPLY=( $(compgen -W "${multi_cmds}" -- "$cur") )
            else
                COMPREPLY=( $(compgen -W "${flags}" -- "$cur") )
            fi
            ;;
        hub)
            if [[ $cword -eq 2 ]]; then
                COMPREPLY=( $(compgen -W "${hub_cmds}" -- "$cur") )
            fi
            ;;
        doctor)
            COMPREPLY=( $(compgen -W "--fix --reset" -- "$cur") )
            ;;
        setup|auto|codex|gemini)
            if [[ "$cur" == -* ]]; then
                COMPREPLY=( $(compgen -W "${flags}" -- "$cur") )
            fi
            ;;
    esac
}

complete -F _tfx_completion tfx
