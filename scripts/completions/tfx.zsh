#compdef tfx
# Installation: fpath에 추가 후 compinit
# e.g., fpath=(/path/to/dir $fpath) && compinit

_tfx() {
    local line state
    local -a commands multi_cmds hub_cmds flags

    commands=(
        'setup:Setup and sync files'
        'doctor:Diagnose CLI and issues'
        'multi:Multi-CLI team mode'
        'hub:MCP message bus management'
        'auto:Auto mode'
        'codex:Codex mode'
        'gemini:Gemini mode'
    )

    multi_cmds=(
        'status:Show status'
        'stop:Stop multi'
        'kill:Kill multi'
        'attach:Attach to multi'
        'list:List multi sessions'
    )

    hub_cmds=(
        'start:Start hub'
        'stop:Stop hub'
        'status:Show hub status'
        'restart:Restart hub'
    )

    _arguments -C \
        '1: :->cmds' \
        '*: :->args'

    case $state in
        cmds)
            _describe -t commands 'tfx commands' commands
            ;;
        args)
            case $words[2] in
                multi)
                    if (( CURRENT == 3 )) && [[ $words[CURRENT] != -* ]]; then
                        _describe -t multi_cmds 'multi commands' multi_cmds
                    else
                        _arguments \
                            '--thorough[Thorough execution]' \
                            '--quick[Quick execution]' \
                            '--tmux[Use tmux]' \
                            '--psmux[Use psmux]' \
                            '--agents[Specify agents]' \
                            '--no-attach[Do not attach]' \
                            '--timeout[Set timeout]'
                    fi
                    ;;
                hub)
                    if (( CURRENT == 3 )); then
                        _describe -t hub_cmds 'hub commands' hub_cmds
                    fi
                    ;;
                doctor)
                    _arguments \
                        '--fix[Auto fix issues]' \
                        '--reset[Reset all caches]'
                    ;;
                *)
                    _arguments \
                        '--thorough[Thorough execution]' \
                        '--quick[Quick execution]' \
                        '--tmux[Use tmux]' \
                        '--psmux[Use psmux]' \
                        '--agents[Specify agents]' \
                        '--no-attach[Do not attach]' \
                        '--timeout[Set timeout]'
                    ;;
            esac
            ;;
    esac
}

_tfx "$@"
