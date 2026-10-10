import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions } from 'claude-code'

import type { BandRows, BandSpan } from '../types'

const rows = atom({ plugin: 'triflux-mods', key: 'rows' } as const, null)

// 'above' 는 statusLine HUD 의 c, x, a 행을 입력창 위 band 에 그리고, 'statusline' 은 statusLine 에 맡긴다.
export type BandPosition = 'above' | 'statusline'

const REFRESH_MS = 60_000
const NODE_CANDIDATES = ['node', '/opt/homebrew/bin/node', '/usr/local/bin/node']
const NAMED_COLORS: Record<number, string> = {
  30: 'black', 31: 'red', 32: 'green', 33: 'yellow', 34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'white',
  90: 'gray', 91: 'redBright', 92: 'greenBright', 93: 'yellowBright', 94: 'blueBright', 95: 'magentaBright',
  96: 'cyanBright', 97: 'whiteBright',
}

function hex(r: number, g: number, b: number) {
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`
}

function xterm256(n: number) {
  if (n < 16) return NAMED_COLORS[n < 8 ? 30 + n : 82 + n]
  if (n >= 232) return hex(8 + 10 * (n - 232), 8 + 10 * (n - 232), 8 + 10 * (n - 232))
  const level = (v: number) => (v ? 55 + v * 40 : 0)
  const i = n - 16
  return hex(level(Math.floor(i / 36)), level(Math.floor(i / 6) % 6), level(i % 6))
}

function applySgr(style: Omit<BandSpan, 'text'>, params: string) {
  const codes = params === '' ? [0] : params.split(';').map(Number)
  let next = { ...style }
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]
    if (code === 0) next = {}
    else if (code === 1) next.bold = true
    else if (code === 2) next.dim = true
    else if (code === 22) next = { ...next, bold: false, dim: false }
    else if (code === 39) next.color = undefined
    else if (code === 38 && codes[i + 1] === 2) {
      next.color = hex(codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0)
      i += 4
    } else if (code === 38 && codes[i + 1] === 5) {
      next.color = xterm256(codes[i + 2] ?? 0)
      i += 2
    } else if (code !== undefined && NAMED_COLORS[code]) next.color = NAMED_COLORS[code]
  }
  return next
}

// HUD 의 ANSI 색 코드를 Text 조각으로 바꾼다. HUD 가 쓰는 SGR(굵게, 흐리게, 16/256/트루컬러)만 다룬다.
export function parseAnsi(line: string): BandSpan[] {
  const spans: BandSpan[] = []
  const pattern = /\x1b\[([0-9;]*)m/g
  let style: Omit<BandSpan, 'text'> = {}
  let last = 0
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    if (match.index > last) spans.push({ text: line.slice(last, match.index), ...style })
    style = applySgr(style, match[1] ?? '')
    last = pattern.lastIndex
  }
  if (last < line.length) spans.push({ text: line.slice(last), ...style })
  return spans
}

// statusLine 은 os.homedir() 를 쓴다. Windows 에는 HOME 이 없을 수 있다.
async function homeDir($: EngineInterface) {
  return (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
}

async function runHud($: EngineInterface, hudPath: string, stdin: string, columns: number) {
  for (const node of NODE_CANDIDATES) {
    try {
      return await $.process.run([node, hudPath, '--band'], {
        stdin,
        env: { COLUMNS: String(columns) },
        timeoutMs: 10_000,
      })
    } catch {}
  }
  return null
}

// 선택 기능이라 실패를 삼킨다. hook 오류가 쌓이면 mod 전체가 꺼진다.
// 표식이 "all:" 이면 statusLine HUD 가 아무것도 그리지 않고, "off" 면 다 그린다(hud/hud-qos-status.mjs).
async function refreshRows($: EngineInterface, position: BandPosition, columns: number) {
  try {
    const home = await homeDir($)
    if (!home) return
    const sessionId = await $.session.id()
    const marker = `${home}/.claude/cache/triflux/claude-band/${sessionId}`
    if (position === 'statusline') {
      await $.fs.write(marker, 'off')
      return
    }
    const { rateLimits, context } = await $.session.usage()
    const stdin = JSON.stringify({
      session_id: sessionId,
      context_window: {
        context_window_size: context.window,
        used_percentage: context.percent,
        current_usage: { total_tokens: context.tokens },
      },
      claude_rate_limits: rateLimits,
    })
    // TFX_HUD_PATH 는 설치본 대신 저장소의 HUD 를 돌려 볼 때 쓴다.
    const hudPath = (await $.env.get('TFX_HUD_PATH')) || `${home}/.claude/hud/hud-qos-status.mjs`
    const result = await runHud($, hudPath, stdin, columns)
    const lines = (result?.exitCode === 0 ? result.stdout : '')
      .split('\n')
      .map(parseAnsi)
      .filter(spans => spans.some(s => s.text.trim()))
    // HUD 를 못 돌리면 band 를 비우고 statusLine 이 그리게 둔다.
    const snapshot: BandRows | null = lines.length > 0 ? { columns, lines } : null
    await update($, rows, () => snapshot)
    await $.fs.write(marker, snapshot ? `all:${await $.clock.now()}` : 'off')
  } catch {}
}

export function registerHudBand(on: On, options: PluginOptions) {
  const position: BandPosition = options.position === 'statusline' ? 'statusline' : 'above'
  // 다음 갱신 때 HUD 에 넘길 터미널 폭. band 를 그릴 때마다 맞춘다.
  let columns = 120

  on('session.start', async ($, e, next) => {
    await refreshRows($, position, columns)
    // 남은 시간 표시와 Codex, Antigravity 캐시 갱신을 응답 없이도 따라간다.
    if (position === 'above') $.clock.every(REFRESH_MS, () => refreshRows($, position, columns))
    return next(e)
  })

  // 응답이 끝날 때마다 rate limit 과 context 가 바뀐다.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await refreshRows($, position, columns)
    return result
  })

  if (position === 'statusline') return

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // bodyColumns 는 오른쪽 5칸을 뺀 폭이라 HUD 가 보는 터미널 폭으로 되돌린다.
    columns = e.props.bodyColumns + 5
    const snapshot = await read($, rows)
    if (e.props.hasSurvey || !snapshot) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    // statusLine 처럼 두 칸 들여 쓰고, 폭이 줄면 다음 갱신 전까지 끝을 자른다.
    return (
      <Box flexDirection="column">
        {snapshot.lines.map(spans => (
          <Text wrap="truncate-end">
            {[{ text: '  ' }, ...spans].map(s => (
              <Text color={s.color} bold={s.bold} dimColor={s.dim}>
                {s.text}
              </Text>
            ))}
          </Text>
        ))}
      </Box>
    )
  })
}
