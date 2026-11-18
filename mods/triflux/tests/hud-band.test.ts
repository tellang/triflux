import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { parseAnsi } from '../hooks/hud-band.tsx'

test('HUD 의 ANSI 색 코드를 Text 조각으로 바꾼다', async () => {
  const line = '\x1b[0m\x1b[1m\x1b[38;2;232;112;64mc\x1b[0m: \x1b[2m5h:\x1b[0m\x1b[33m 83%\x1b[0m \x1b[38;5;39mGCP\x1b[0m'
  expect(parseAnsi(line)).toEqual([
    { text: 'c', bold: true, color: '#e87040' },
    { text: ': ' },
    { text: '5h:', dim: true },
    { text: ' 83%', color: 'yellow' },
    { text: ' ' },
    { text: 'GCP', color: '#00afff' },
  ])
})

function measureFixture(on: On, isLead = true) {
  mock.clock(on, { now: 1_700_000_000_000 })
  mock.store(
    on,
    isLead
      ? { 'tfx.lead.lead-1': { role: '개발리드', since: '2026-11-18T00:00:00.000Z' } }
      : {},
  )
  mock.env(on, { HOME: '/home/test' })
  on('session.id', () => ({ value: 'lead-1' }))
  on('session.measure', (_, e) => ({ changed: [...e.changed] }))
  on('session.usage', () => ({ value: { context: { window: 1000, tokens: 0, percent: 0 }, rateLimits: [] } }) as never)
  on('fs.write', () => ({ value: undefined }))
  const peers: string[] = []
  const toasts: string[] = []
  on('process.run', (_, e) => {
    if (e.argv[0] === 'tfx-peer') peers.push(e.argv[e.argv.indexOf('--message') + 1] ?? '')
    return {
      value: {
        exitCode: 0,
        stdout: e.argv[0] === 'tfx-peer' ? '{"status":"written"}' : '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { peers, toasts }
}

test('session.measure 때 리드 세션의 컨텍스트 사용량이 85% 이상이면 승계 알림을 1회만 보낸다', async ($, on) => {
  const f = measureFixture(on, true)
  await $.session.measure({
    context: { window: 200_000, tokens: 160_000, percent: 80 },
    rateLimits: [],
    cost: { totalUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0 },
    changed: ['context'],
  })
  expect(f.peers).toEqual([])

  await $.session.measure({
    context: { window: 200_000, tokens: 170_000, percent: 85.4 },
    rateLimits: [],
    cost: { totalUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0 },
    changed: ['context'],
  })
  expect(f.peers).toEqual(['[tfx-lead] 컨텍스트 사용량이 85%에 도달했다. 인계 파일을 저장하고 세션을 승계하라.'])

  await $.session.measure({
    context: { window: 200_000, tokens: 180_000, percent: 90 },
    rateLimits: [],
    cost: { totalUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0 },
    changed: ['context'],
  })
  expect(f.peers).toHaveLength(1)
})
