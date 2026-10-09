import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions } from 'claude-code'

import type { UsageSnapshot } from '../types'

const usage = atom({ plugin: 'triflux-mods', key: 'usage' } as const, null)

// statusLine HUD(hud/renderers.mjs 의 Claude 행)와 같은 모양으로 그린다.
const CLAUDE_ORANGE = '#E87040'
const GAUGE_WIDTH = 5
const WINDOW_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '1w' }

// 'statusline' 이면 band 를 그리지 않고 statusLine HUD 가 입력창 아래에서 Claude 행을 그린다.
export type BandPosition = 'above' | 'statusline'

// 선택 기능이라 실패를 삼킨다. hook 오류가 쌓이면 mod 전체가 꺼진다.
async function refreshUsage($: EngineInterface, position: BandPosition) {
  try {
    const { rateLimits, context, cost } = await $.session.usage()
    const snapshot: UsageSnapshot = {
      windows: rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
      contextPercent: context.percent ?? null,
      costUsd: cost?.usd ?? null,
    }
    await update($, usage, () => snapshot)
    // 표식이 "off" 가 아니고 신선할 때만 statusLine HUD 가 Claude 행을 뺀다(hud/hud-qos-status.mjs).
    const home = await $.env.get('HOME')
    if (home && snapshot.windows.length > 0) {
      const marker = position === 'above' ? String(await $.clock.now()) : 'off'
      await $.fs.write(`${home}/.claude/cache/triflux/claude-band/${await $.session.id()}`, marker)
    }
  } catch {}
}

export function formatRemaining(kind: string, resetsAt: string | undefined, now: number) {
  const dayHour = kind !== 'five_hour'
  if (!resetsAt) return dayHour ? '(--d--h)' : '(--h--m)'
  const minutes = Math.max(0, Math.floor((Date.parse(resetsAt) - now) / 60000))
  const pad = (n: number) => String(n).padStart(2, '0')
  return dayHour
    ? `(${pad(Math.floor(minutes / 1440))}d${pad(Math.floor((minutes % 1440) / 60))}h)`
    : `(${pad(Math.floor(minutes / 60))}h${pad(minutes % 60)}m)`
}

function quotaColor(percent: number) {
  return percent >= 85 ? 'red' : percent >= 70 ? 'yellow' : CLAUDE_ORANGE
}

function contextColor(percent: number) {
  return percent >= 85 ? 'red' : percent >= 70 ? 'yellow' : percent >= 50 ? 'cyan' : 'green'
}

// hud/colors.mjs coloredBar 와 같은 블록 규칙. [채운 부분, 빈 부분]
export function gaugeParts(percent: number): [string, string] {
  const safe = Math.min(100, Math.max(0, percent))
  const perBlock = 100 / GAUGE_WIDTH
  let bar = ''
  for (let i = 0; i < GAUGE_WIDTH; i++) {
    const progress = (safe - i * perBlock) / perBlock
    bar += progress >= 1 ? '█' : progress >= 0.75 ? '▓' : progress >= 0.33 ? '▒' : '░'
  }
  const filled = Math.ceil(safe / perBlock)
  return [bar.slice(0, filled), bar.slice(filled)]
}

export function registerHudBand(on: On, options: PluginOptions) {
  const position: BandPosition = options.position === 'statusline' ? 'statusline' : 'above'

  on('session.start', async ($, e, next) => {
    await refreshUsage($, position)
    return next(e)
  })

  // 응답이 끝날 때마다 rate limit 과 비용이 바뀐다.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await refreshUsage($, position)
    return result
  })

  if (position === 'statusline') return

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snapshot = await read($, usage)
    if (e.props.hasSurvey || !snapshot || snapshot.windows.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    // HUD 의 폭 단계와 맞춘다: 120칸 이상만 막대, 80칸 미만은 남은 시간을 뺀다. bodyColumns 는 오른쪽 5칸을 뺀 폭이다.
    const columns = e.props.bodyColumns + 5
    const windows = snapshot.windows.filter(w => WINDOW_LABEL[w.kind])

    // Fragment 로 묶으면 Text 가 세로로 쌓여서 한 줄짜리 배열로 편다.
    const windowCells = windows.flatMap((w, i) => {
      const color = quotaColor(w.percentUsed)
      const [filled, empty] = gaugeParts(w.percentUsed)
      const cells = [<Text dimColor>{`${i > 0 ? ' ' : ''}${WINDOW_LABEL[w.kind]}:`}</Text>]
      if (columns >= 120) cells.push(<Text color={color}>{filled}</Text>, <Text dimColor>{`${empty} `}</Text>)
      cells.push(<Text color={color}>{`${Math.round(w.percentUsed)}%`.padStart(4)}</Text>)
      if (columns >= 80) cells.push(<Text dimColor>{` ${formatRemaining(w.kind, w.resetsAt, now)}`}</Text>)
      return cells
    })

    return (
      <Box paddingLeft={2}>
        <Text bold color={CLAUDE_ORANGE}>c</Text>
        <Text>: </Text>
        {windowCells}
        <Text dimColor> | CTX:</Text>
        {snapshot.contextPercent === null ? (
          <Text dimColor>--%</Text>
        ) : (
          <Text color={contextColor(snapshot.contextPercent)}>{`${snapshot.contextPercent}%`}</Text>
        )}
        {snapshot.costUsd !== null && <Text dimColor>{` $${snapshot.costUsd.toFixed(2)}`}</Text>}
      </Box>
    )
  })
}
