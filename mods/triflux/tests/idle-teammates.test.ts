import type { AgentInfo, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const keep = { command: 'tfx-keep', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const
const start = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const
const teammate: AgentInfo = { id: 'w1@team', teammateId: 'w1@team', name: 'w1', description: '리뷰', type: 'teammate', status: 'idle' }

function fixture(on: On, isLead: boolean) {
  const clock = mock.clock(on)
  mock.store(on, isLead ? { 'tfx.lead.lead-1': { role: '개발리드', since: '2026-10-23T00:00:00.000Z' } } : {})
  mock.env(on, { HOME: '/home/test' })
  on('session.id', () => ({ value: 'lead-1' }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.usage', () => ({ value: { context: { window: 1000, tokens: 0, percent: 0 }, rateLimits: [] } }) as never)
  on('fs.write', () => ({ value: undefined }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__triflux-mods__${e.name}` } }))
  on('agent.list', () => ({ value: [teammate] }))
  const peers: string[] = []
  on('process.run', (_, e) => {
    if (e.argv[0] === 'tfx-peer') peers.push(e.argv[e.argv.indexOf('--message') + 1] ?? '')
    return { value: { exitCode: 0, stdout: e.argv[0] === 'tfx-peer' ? '{"status":"written"}' : 'Darwin\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const sends: unknown[] = []
  on('tool.call', { tool: 'SendMessage' }, (_, e) => { if (typeof e.message !== 'string') sends.push({ to: e.to, message: e.message }); return { result: 'ok' } })
  return { clock, peers, sends }
}

test('리드 세션은 10분 쉰 팀원을 알리고 10분 뒤에도 열려 있으면 종료를 요청한다', async ($, on) => {
  const f = fixture(on, true)
  await $.session.start(start)
  await f.clock.advance(600_000)
  expect(f.peers).toEqual([])
  await f.clock.advance(120_000)
  expect(f.peers).toHaveLength(1)
  expect(f.peers[0]).toContain('팀원 1개가 열려 있다: w1 10분')
  await f.clock.advance(480_000)
  expect(f.sends).toEqual([])
  await f.clock.advance(120_000)
  expect(f.sends).toEqual([{ to: 'w1', message: { type: 'shutdown_request', reason: expect.stringContaining('20분째') } }])
  await f.clock.advance(1_200_000)
  expect(f.peers).toHaveLength(1)
  expect(f.sends).toHaveLength(1)
})

test('리드가 아닌 세션은 팀원을 알리거나 종료하지 않는다', async ($, on) => {
  const f = fixture(on, false)
  await $.session.start(start)
  await f.clock.advance(3_600_000)
  expect(f.peers).toEqual([])
  expect(f.sends).toEqual([])
})

test('리드가 팀원에게 다시 보내면 유휴 시계를 처음부터 잰다', async ($, on) => {
  const f = fixture(on, true)
  await $.session.start(start)
  await f.clock.advance(600_000)
  await $.tool.call({ tool: 'SendMessage', to: 'w1', message: '리뷰 지적 반영' })
  await f.clock.advance(120_000)
  expect(f.peers).toEqual([])
  await f.clock.advance(600_000)
  expect(f.peers).toHaveLength(1)
})

test('/tfx-keep 으로 남긴 팀원은 알림에 유지로 표시하고 종료를 요청하지 않는다', async ($, on) => {
  const f = fixture(on, true)
  await $.session.start(start)
  await $.command.run({ ...keep, args: 'w1' })
  await f.clock.advance(1_800_000)
  expect(f.peers[0]).toContain('w1 10분(유지)')
  expect(f.sends).toEqual([])
  expect((await $.command.run({ ...keep, args: 'w1 off' })).text).toBe('유지 팀원: 없음')
})
