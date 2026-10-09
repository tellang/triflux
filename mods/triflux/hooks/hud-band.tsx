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

// statusLine 은 os.homedir() 를 쓴다. Windows 에는 HOME 이 없을 수 있다.
async function homeDir($: EngineInterface) {
  return (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
}

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
    const home = await homeDir($)
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

// 설정 파일이 없거나 깨졌으면 설정 없이 폭으로만 고른다.
async function readTierInput($: EngineInterface): Promise<TierInput> {
  try {
    const [home, compactEnv, minimalEnv, termuxVersion] = await Promise.all([
      homeDir($),
      $.env.get('OMC_HUD_COMPACT'),
      $.env.get('OMC_HUD_MINIMAL'),
      $.env.get('TERMUX_VERSION'),
    ])
    let config: HudConfig | null = null
    try {
      config = JSON.parse(String(await $.fs.read(`${home}/.omc/config/hud.json`)))
    } catch {}
    return { config, compactEnv, minimalEnv, termux: Boolean(termuxVersion) }
  } catch {
    return { config: null }
  }
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

  // HUD 설정은 statusLine 이 매번 읽으므로 band 도 갱신 때마다 다시 읽는다.
  on('session.start', async ($, e, next) => {
    tierInput = await readTierInput($)
    await refreshUsage($, position)
    return next(e)
  })

  // 응답이 끝날 때마다 rate limit 과 비용이 바뀐다.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    tierInput = await readTierInput($)
    await refreshUsage($, position)
    return result
  })

  if (position === 'statusline') return

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snapshot = await read($, usage)
    if (e.props.hasSurvey || !snapshot || snapshot.windows.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const width = e.props.bodyColumns
    // bodyColumns 는 오른쪽 5칸을 뺀 폭이라 HUD 와 같은 터미널 폭으로 되돌려 단계를 고른다.
    const tier = selectTier(width + 5, tierInput)
    type Part = { text: string; color?: string; dim?: boolean; bold?: boolean }
    const prefix: Part[] = [{ text: '  ' }, { text: 'c', color: CLAUDE_ORANGE, bold: true }, { text: ': ' }]

    // hud/renderers.mjs getClaudeRows 의 micro, nano 행: 퍼센트만 / 로 잇는다.
    const microParts = snapshot.windows.flatMap((w, i): Part[] => [
      ...(i > 0 ? [{ text: '/', dim: true }] : []),
      { text: `${Math.round(w.percentUsed)}%`, color: quotaColor(w.percentUsed) },
    ])

    const windowParts = snapshot.windows.flatMap((w, i): Part[] => {
      const color = quotaColor(w.percentUsed)
      const [filled, empty] = gaugeParts(w.percentUsed)
      const parts: Part[] = [{ text: `${i > 0 ? ' ' : ''}${WINDOW_LABEL[w.kind]}:`, dim: true }]
      if (tier === 'full') parts.push({ text: filled, color }, { text: `${empty} `, dim: true })
      parts.push({ text: `${Math.round(w.percentUsed)}%`.padStart(4), color })
      if (tier !== 'minimal') parts.push({ text: ` ${formatRemaining(w.kind, w.resetsAt, now)}`, dim: true })
      return parts
    })
    const ctx = snapshot.contextPercent
    const contextParts: Part[] = [
      { text: ' | CTX:', dim: true },
      ctx === null ? { text: '--%', dim: true } : { text: `${ctx}%`, color: contextColor(ctx) },
    ]
    const costParts: Part[] = snapshot.costUsd === null ? [] : [{ text: ` $${snapshot.costUsd.toFixed(2)}`, dim: true }]

    // 한 줄에 안 들어가면 비용부터 빼고, 그래도 넘치면 micro 행으로 줄이고, 그것도 넘치면 끝을 자른다.
    // 생략하면 표식 때문에 HUD 의 c 행까지 숨어서 둘 다 사라진다.
    const fits = (parts: Part[]) => parts.reduce((n, p) => n + p.text.length, 0) <= width
    const microRow = [...prefix, ...microParts]
    const wideRows =
      tier === 'micro' || tier === 'nano'
        ? []
        : [
            [...prefix, ...windowParts, ...contextParts, ...costParts],
            [...prefix, ...windowParts, ...contextParts],
          ]
    const parts = wideRows.find(fits) ?? microRow

    // Fragment 로 묶으면 Text 가 세로로 쌓여서 바깥 Text 하나에 넣고 한 줄로 자른다.
    return (
      <Box>
        <Text wrap="truncate-end">
          {parts.map(p => (
            <Text color={p.color} dimColor={p.dim} bold={p.bold}>
              {p.text}
            </Text>
          ))}
        </Text>
      </Box>
    )
  })
}
