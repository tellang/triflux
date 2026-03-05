# triflux Demo — Dark Theme
# VHS: https://github.com/charmbracelet/vhs
# 실행: vhs docs/demo.tape

Output docs/assets/demo-dark.gif

Set Theme "Catppuccin Mocha"
Set FontFamily "JetBrains Mono"
Set FontSize 14
Set Width 900
Set Height 500
Set Padding 20
Set TypingSpeed 40ms

# 타이틀
Type "# triflux — CLI-first multi-model orchestrator"
Enter
Sleep 1s

# 설치 확인
Type "tfx doctor"
Enter
Sleep 3s

# Auto mode 데모
Type "# Auto mode — AI가 분류 + 분해 + 병렬 실행"
Enter
Sleep 500ms
Type@80ms 'claude "/tfx-auto refactor auth module + improve login UI + add tests"'
Enter
Sleep 2s

# 트리아지 시뮬레이션
Type "# Phase 2: Triage"
Enter
Type "# auth refactor → codex (executor)"
Enter
Type "# login UI     → gemini (designer)"
Enter
Type "# tests        → claude (test-engineer)"
Enter
Sleep 2s

# 병렬 실행 시뮬레이션
Type "# Phase 3: Parallel Execution"
Enter
Type "# [codex] executor: src/auth/ ████████████ done (45s)"
Enter
Type "# [gemini] designer: src/components/ ████████████ done (30s)"
Enter
Type "# [claude] test-engineer: tests/ ████████████ done (25s)"
Enter
Sleep 2s

# 커맨드 숏컷 데모
Type "# Command shortcuts — instant single-agent execution"
Enter
Sleep 500ms
Type@80ms 'claude "/implement add JWT auth middleware"'
Enter
Sleep 2s
Type@80ms 'claude "/analyze security review of payment module"'
Enter
Sleep 2s

# 완료
Type "# Done! Token savings: $0.94 (Codex free tier)"
Enter
Sleep 3s
