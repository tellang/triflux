import { expect, test } from 'claude-code/testing'

import { formatRemaining, gaugeParts, selectTier } from '../hooks/hud-band.tsx'

test('막대와 남은 시간을 statusLine HUD 의 Claude 행과 같은 모양으로 만든다', async () => {
  expect(gaugeParts(19)).toEqual(['▓', '░░░░'])
  expect(gaugeParts(82)).toEqual(['████░', ''])
  const now = Date.parse('2026-10-09T00:00:00Z')
  expect(formatRemaining('five_hour', '2026-10-09T01:37:30Z', now)).toBe('(01h37m)')
  expect(formatRemaining('seven_day', '2026-10-11T10:05:00Z', now)).toBe('(02d10h)')
  expect(formatRemaining('seven_day', undefined, now)).toBe('(--d--h)')
})

test('폭 단계를 statusLine HUD 의 selectTier 와 같은 기준으로 고른다', async () => {
  const none = { config: null }
  expect([130, 100, 70, 50, 30].map(c => selectTier(c, none))).toEqual(['full', 'compact', 'compact', 'micro', 'nano'])
  expect(selectTier(50, { config: { tier: 'full' } })).toBe('full')
  expect(selectTier(130, { config: null, compactEnv: '1' })).toBe('compact')
  expect(selectTier(130, { config: { compact: 'always' }, compactEnv: '0' })).toBe('full')
})
