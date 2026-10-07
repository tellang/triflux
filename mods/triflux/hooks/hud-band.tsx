import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { UsageSnapshot, UsageWindow } from '../types'

const usage = atom({ plugin: 'triflux-mods', key: 'usage' } as const, null)

const WINDOW_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '1w', spend_limit: '$' }

async function refreshUsage($: EngineInterface) {
  const { rateLimits, context, cost } = await $.session.usage()
  const snapshot: UsageSnapshot = {
    windows: rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
    contextPercent: context.percent ?? null,
    costUsd: cost?.usd ?? null,
  }
  await update($, usage, () => snapshot)
  // statusLine HUD 가 이 파일을 보고 Claude 행을 뺀다(hud/hud-qos-status.mjs).
  const home = await $.env.get('HOME')
  if (home) await $.fs.write(`${home}/.claude/cache/triflux/claude-band/${await $.session.id()}`, String(await $.clock.now()))
}

function formatRemaining(resetsAt: string | undefined, now: number) {
  if (!resetsAt) return ''
  const minutes = Math.max(0, Math.round((Date.parse(resetsAt) - now) / 60000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  return days > 0 ? `${days}d${String(hours).padStart(2, '0')}h` : `${hours}h${String(minutes % 60).padStart(2, '0')}m`
}

function percentColor(percent: number) {
  return percent >= 80 ? 'error' : percent >= 50 ? 'warning' : undefined
}

export function registerHudBand(on: On) {
  on('session.start', async ($, e, next) => {
    await refreshUsage($)
    return next(e)
  })

  // 응답이 끝날 때마다 rate limit 과 비용이 바뀐다.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await refreshUsage($)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snapshot = await read($, usage)
    if (e.props.hasSurvey || !snapshot || snapshot.windows.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const windowText = (w: UsageWindow) =>
      `${WINDOW_LABEL[w.kind] ?? w.kind} ${Math.round(w.percentUsed)}% ${formatRemaining(w.resetsAt, now)}`.trimEnd()

    return (
      <Box>
        <Text dimColor>c </Text>
        {snapshot.windows.map((w, i) => (
          <Text color={percentColor(w.percentUsed)} dimColor={!percentColor(w.percentUsed)}>
            {i > 0 ? ' · ' : ''}
            {windowText(w)}
          </Text>
        ))}
        {snapshot.contextPercent !== null && <Text dimColor> · ctx {snapshot.contextPercent}%</Text>}
        {snapshot.costUsd !== null && <Text dimColor> · ${snapshot.costUsd.toFixed(2)}</Text>}
      </Box>
    )
  })
}
