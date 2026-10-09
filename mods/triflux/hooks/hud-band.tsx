import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions } from 'claude-code'

import type { UsageSnapshot } from '../types'

const usage = atom({ plugin: 'triflux-mods', key: 'usage' } as const, null)

// statusLine HUD(hud/renderers.mjs 의 Claude 행)와 같은 모양으로 그린다.
const CLAUDE_ORANGE = '#E87040'
const GAUGE_WIDTH = 5
const WINDOW_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '1w', spend_limit: '$' }

// 'statusline' 이면 band 를 그리지 않고 statusLine HUD 가 입력창 아래에서 Claude 행을 그린다.
export type BandPosition = 'above' | 'statusline'

// 선택 기능이라 실패를 삼킨다. hook 오류가 쌓이면 mod 전체가 꺼진다.
async function refreshUsage($: EngineInterface, position: BandPosition) {
  try {
    const { rateLimits, context, cost } = await $.session.usage()
    const snapshot: UsageSnapshot = {
      // 그릴 수 있는 창만 남겨야 band 표시와 HUD 표식이 같은 조건을 본다.
      windows: rateLimits
        .filter(({ kind }) => WINDOW_LABEL[kind])
        .map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
      contextPercent: context.percent ?? null,
      costUsd: cost?.usd ?? null,
    }
    await update($, usage, () => snapshot)
    // 표식이 "off" 가 아니고 신선할 때만 statusLine HUD 가 Claude 행을 뺀다(hud/hud-qos-status.mjs).
    // statusline 은 사용량이 아직 없어도 off 를 써야 같은 세션의 이전 above 표식이 c 행을 숨기지 않는다.
    const home = await $.env.get('HOME')
    const marker = position === 'statusline' ? 'off' : snapshot.windows.length > 0 ? String(await $.clock.now()) : null
    if (home && marker) await $.fs.write(`${home}/.claude/cache/triflux/claude-band/${await $.session.id()}`, marker)
  } catch {}
}

export type HudTier = 'full' | 'compact' | 'minimal' | 'micro' | 'nano'
export type HudConfig = {
  tier?: string
  lines?: number | string
  compact?: boolean | string
  autoResize?: boolean
  compactThreshold?: number | string
}
type TierInput = { config: HudConfig | null; compactEnv?: string; minimalEnv?: string; termux?: boolean }

const TIERS: readonly string[] = ['full', 'compact', 'minimal', 'micro', 'nano']

// hud/terminal.mjs selectTier, detectCompactMode, detectMinimalMode 를 옮긴 것이다. 같은 설정에서 같은 단계를 골라야 한다.
export function selectTier(columns: number, input: TierInput): HudTier {
  const { config, minimalEnv } = input
  if (config?.tier && TIERS.includes(config.tier)) return config.tier as HudTier
  const lines = Number(config?.lines)
  if (lines === 1 || columns < 40) return 'nano'
  const minimal = minimalEnv === '1' || (minimalEnv !== '0' && (config?.compact === 'minimal' || columns < 60))
  if (minimal) return 'micro'
  if (compactModeOn(columns, lines, input)) return 'compact'
  if (config?.autoResize === false) return 'full'
  return columns >= 120 ? 'full' : columns >= 80 ? 'compact' : columns >= 60 ? 'minimal' : 'micro'
}

// Termux, 환경변수, 설정 파일, 폭 순서. detectCompactMode 와 우선순위가 같아야 한다.
function compactModeOn(columns: number, lines: number, { config, compactEnv, termux }: TierInput) {
  if (termux) return true
  if (compactEnv === '1') return true
  if (compactEnv === '0') return false
  if (config?.compact === true || config?.compact === 'always') return true
  if (config?.compact === false || config?.compact === 'never') return false
  return (lines > 0 && lines < 3) || columns < (Number(config?.compactThreshold) || 80)
}

async function readTierInput($: EngineInterface): Promise<TierInput> {
  const [home, compactEnv, minimalEnv, termuxVersion] = await Promise.all([
    $.env.get('HOME'),
    $.env.get('OMC_HUD_COMPACT'),
    $.env.get('OMC_HUD_MINIMAL'),
    $.env.get('TERMUX_VERSION'),
  ])
  let config: HudConfig | null = null
  try {
    config = JSON.parse(String(await $.fs.read(`${home}/.omc/config/hud.json`)))
  } catch {}
  return { config, compactEnv, minimalEnv, termux: Boolean(termuxVersion) }
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
  let tierInput: TierInput = { config: null }

  on('session.start', async ($, e, next) => {
    try {
      tierInput = await readTierInput($)
    } catch {}
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
    // bodyColumns 는 오른쪽 5칸을 뺀 폭이다.
    const tier = selectTier(e.props.bodyColumns + 5, tierInput)
    const prefix = [
      <Text bold color={CLAUDE_ORANGE}>c</Text>,
      <Text>: </Text>,
    ]

    // hud/renderers.mjs getClaudeRows 의 micro, nano 행: 퍼센트만 / 로 잇는다.
    if (tier === 'micro' || tier === 'nano') {
      const percents = snapshot.windows.flatMap((w, i) => [
        ...(i > 0 ? [<Text dimColor>/</Text>] : []),
        <Text color={quotaColor(w.percentUsed)}>{`${Math.round(w.percentUsed)}%`}</Text>,
      ])
      return <Box paddingLeft={2}>{[...prefix, ...percents]}</Box>
    }

    // Fragment 로 묶으면 Text 가 세로로 쌓여서 한 줄짜리 배열로 편다.
    const windowCells = snapshot.windows.flatMap((w, i) => {
      const color = quotaColor(w.percentUsed)
      const [filled, empty] = gaugeParts(w.percentUsed)
      const cells = [<Text dimColor>{`${i > 0 ? ' ' : ''}${WINDOW_LABEL[w.kind]}:`}</Text>]
      if (tier === 'full') cells.push(<Text color={color}>{filled}</Text>, <Text dimColor>{`${empty} `}</Text>)
      cells.push(<Text color={color}>{`${Math.round(w.percentUsed)}%`.padStart(4)}</Text>)
      if (tier !== 'minimal') cells.push(<Text dimColor>{` ${formatRemaining(w.kind, w.resetsAt, now)}`}</Text>)
      return cells
    })

    return (
      <Box paddingLeft={2}>
        {prefix}
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
