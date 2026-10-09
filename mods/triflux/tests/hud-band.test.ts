import { expect, test } from 'claude-code/testing'

import { formatRemaining, gaugeParts } from '../hooks/hud-band.tsx'

test('막대와 남은 시간을 statusLine HUD 의 Claude 행과 같은 모양으로 만든다', async () => {
  expect(gaugeParts(19)).toEqual(['▓', '░░░░'])
  expect(gaugeParts(82)).toEqual(['████░', ''])
  const now = Date.parse('2026-10-09T00:00:00Z')
  expect(formatRemaining('five_hour', '2026-10-09T01:37:30Z', now)).toBe('(01h37m)')
  expect(formatRemaining('seven_day', '2026-10-11T10:05:00Z', now)).toBe('(02d10h)')
  expect(formatRemaining('seven_day', undefined, now)).toBe('(--d--h)')
})
