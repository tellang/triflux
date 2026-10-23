import type { EngineInterface, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { advancePressure, type PressureState } from '../hooks/memory-pressure.ts'

for (const [samples, transitions] of [
  [[1], []],
  [[1, 2], []],
  [[1, 2, 2], [{ prev: 1, level: 2 }]],
  [[1, 2, 1, 2], []],
  [[2, 1, 1], [{ prev: 2, level: 1 }]],
  [[1, 2, null, 2], []],
  [[1, 2, null, 2, 2], [{ prev: 1, level: 2 }]],
] as const) {
  test(`표본 ${JSON.stringify(samples)}의 확정 전이`, () => {
    let state: PressureState = {}
    const actual = []
    for (const [i, level] of samples.entries()) {
      const result = advancePressure(state, level, i * 2000)
      state = result.state
      if (result.transition) actual.push(result.transition)
    }
    expect(actual).toEqual(transitions)
  })
}

test('5초 초과 공백 뒤 첫 표본은 후보로 세지 않고 이후 두 표본으로 확정한다', () => {
  let state: PressureState = {}
  for (const [now, level] of [[0, 1], [2000, 2], [8001, 2], [10001, 2]] as const) {
    const result = advancePressure(state, level, now)
    state = result.state
    expect(result.transition).toBeUndefined()
  }
  expect(advancePressure(state, 2, 12001).transition).toEqual({ prev: 1, level: 2 })
})

const start = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const
const pressure = { command: 'tfx-pressure', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

function fixture(on: On) {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/test' })
  const saved = new Map<string, unknown>()
  const prompts: string[] = []
  const contexts: (readonly string[] | undefined)[] = []
  const calls: string[][] = []
  const commands: string[] = []
  const peers: string[][] = []
  // 기본은 피어 전송 실패라 아래 흐름 테스트는 prompt.submit 폴백으로 전이를 받는다.
  const data = { stdout: '1\n', exitCode: 0, platform: 'Darwin\n', sessionId: 'session-a',
    peerResult: undefined as Promise<void> | undefined,
    peer: { exitCode: 1, stdout: '', stderr: 'Claude peer socket missing\n' } as { exitCode: number; stdout: string; stderr: string } | { deny: string } }
  on('store.get', (_, e) => ({ value: saved.get(e.key) }))
  on('store.set', (_, e) => { saved.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_, e) => { saved.delete(e.key); return { value: undefined } })
  on('session.id', () => ({ value: data.sessionId }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.usage', () => ({ value: { context: { window: 1000, tokens: 0, percent: 0 }, rateLimits: [] } }) as never)
  on('process.run', async (_, e) => {
    if (e.argv[0] === 'tfx-peer') {
      peers.push([...e.argv])
      await data.peerResult
      if ('deny' in data.peer) return data.peer
      return { value: { ...data.peer, isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[0] === 'sysctl' || e.argv[0] === 'uname') calls.push([...e.argv])
    return { value: { exitCode: e.argv[0] === 'sysctl' ? data.exitCode : 0,
      stdout: e.argv[0] === 'uname' ? data.platform : e.argv[0] === 'sysctl' ? data.stdout : '',
      stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.write', () => ({ value: undefined }))
  on('command.register', (_, e) => { commands.push(e.name); return { value: { command: e.name } } })
  on('prompt.submit', (_, e) => { prompts.push(e.text); contexts.push(e.context); return { text: e.text } })
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ok' }) as never)
  return { clock, saved, prompts, contexts, calls, commands, peers, data }
}

async function confirmTransition($: EngineInterface, f: ReturnType<typeof fixture>, level: string) {
  await $.session.start(start)
  await $.command.run({ ...pressure, args: 'on' })
  await f.clock.advance(2000)
  f.data.stdout = level
  await f.clock.advance(4000)
}

test('피어 전송이 되면 자기 세션 ID 로 보내고 prompt.submit 을 부르지 않는다', async ($, on) => {
  const f = fixture(on)
  f.data.peer = { exitCode: 0, stdout: '{"status":"written","msgId":"m"}\n', stderr: '' }
  await confirmTransition($, f, '4')
  expect(f.prompts).toEqual([])
  expect(f.peers.length).toBe(1)
  const [command, sub, flag, sessionId, , message] = f.peers[0]
  expect([command, sub, flag, sessionId]).toEqual(['tfx-peer', 'self', '--session', 'session-a'])
  expect(message).toContain('[memory-pressure] 압박 단계가 1 에서 4 로 올랐다. 현재 4 critical (1970-01-01T00:00:06.000Z)')
  expect(message).not.toContain('/tfx-pressure')
})

for (const [label, peer] of [
  ['exit 1', { exitCode: 1, stdout: '', stderr: 'Claude peer socket missing\n' }],
  ['결과 불명', { exitCode: 2, stdout: '{"status":"unknown","retrySafe":false,"error":"peer write outcome unknown"}\n', stderr: '' }],
  ['여러 줄 오류', { exitCode: 1, stdout: '', stderr: `Error: Claude peer socket missing\n    at main (tfx-peer.mjs:1)\n${'x'.repeat(500)}\n` }],
  ['시간 초과', { deny: 'process timeoutMs exceeded' }],
] as const) {
  test(`피어 전송이 ${label}이면 실패 이유를 한 줄 붙여 prompt.submit 으로 보낸다`, async ($, on) => {
    const f = fixture(on)
    f.data.peer = peer
    await confirmTransition($, f, '4')
    expect(f.peers.length).toBe(1)
    expect(f.prompts.length).toBe(1)
    expect(f.prompts[0]).toContain('[memory-pressure] 압박 단계가 1 에서 4 로 올랐다')
    expect(f.prompts[0]).toContain('피어 메시지 전송이 실패해')
    const [, reason] = f.prompts[0].split('\n')
    expect(reason).toContain('deny' in peer ? 'timeoutMs exceeded' : peer.exitCode === 1 ? 'Claude peer socket missing' : '(unknown, peer write outcome unknown)')
    expect(reason.length).toBeLessThan(300)
    expect(f.prompts[0].split('\n').length).toBe(2)
  })
}

test('피어 전송 중 감시를 끄면 실패해도 prompt.submit 으로 폴백하지 않는다', async ($, on) => {
  const f = fixture(on)
  let finish!: () => void
  f.data.peerResult = new Promise<void>(done => { finish = done })
  await confirmTransition($, f, '4')
  expect(f.peers.length).toBe(1)
  await $.command.run({ ...pressure, args: 'off' })
  finish()
  await f.clock.settle()
  expect(f.prompts).toEqual([])
})

test('등록 안 된 세션은 sysctl을 부르지 않는다', async ($, on) => {
  const f = fixture(on)
  await $.session.start(start)
  await f.clock.advance(6000)
  expect(f.commands).toContain('tfx-pressure')
  expect(f.calls).toEqual([])
  expect(f.prompts).toEqual([])
  expect((await $.command.run({ ...pressure, args: 'status' })).text).toContain('압박 감시: off')
})

for (const registered of [false, true]) {
  test(`${registered ? '저장된 등록' : 'on으로 켠 세션'}만 측정하고 확정 전이를 한 번 보낸 뒤 off로 멈춘다`, async ($, on) => {
    const f = fixture(on)
    f.saved.set('tfx.pressure.other', { since: 'keep' })
    if (registered) f.saved.set('tfx.pressure.session-a', { since: 'before' })
    await $.session.start(start)
    if (!registered) await $.command.run({ ...pressure, args: 'on' })
    expect(f.saved.has('tfx.pressure.session-a')).toBe(true)
    await f.clock.advance(2000)
    expect(f.calls).toContainEqual(['sysctl', '-n', 'kern.memorystatus_vm_pressure_level'])
    f.data.stdout = ' 4\n'
    await f.clock.advance(2000)
    expect(f.prompts).toEqual([])
    const pending = await $.command.run({ ...pressure, args: 'status' })
    expect(pending.text).toContain('마지막 유효 표본: 4')
    expect(pending.text).toContain('마지막 확정 단계: 1')
    await f.clock.advance(2000)
    expect(f.prompts.length).toBe(1)
    expect(f.prompts[0]).toContain('1 에서 4')
    expect(f.prompts[0]).toContain('1970-01-01T00:00:06.000Z')
    await f.clock.advance(2000)
    expect(f.prompts.length).toBe(1)
    const status = await $.command.run({ ...pressure, args: 'status' })
    expect(status.text).toContain('압박 감시: on')
    expect(status.text).toContain('1970-01-01T00:00:08.000Z')
    expect(status.text).toContain('마지막 확정 단계: 4')
    await $.command.run({ ...pressure, args: 'off' })
    expect(f.saved.has('tfx.pressure.session-a')).toBe(false)
    expect(f.saved.get('tfx.pressure.other')).toEqual({ since: 'keep' })
    const count = f.calls.length
    f.data.stdout = '2'
    await f.clock.advance(6000)
    expect(f.calls.length).toBe(count)
    expect(f.prompts.length).toBe(1)
  })
}

test('on을 두 번 실행해도 6초 동안 세 번만 측정한다', async ($, on) => {
  const f = fixture(on)
  await $.session.start(start)
  await $.command.run({ ...pressure, args: 'on' })
  await $.command.run({ ...pressure, args: 'on' })
  await f.clock.advance(6000)
  expect(f.calls.filter(argv => argv[0] === 'sysctl').length).toBe(3)
})

for (const registered of [false, true]) {
  test(`세션 ID 변경 때 옛 등록이 ${registered ? '있으면 옮겨 감시를 이어 간다' : '없으면 감시를 멈춘다'}`, async ($, on) => {
    const f = fixture(on)
    await $.session.start(start)
    await $.command.run({ ...pressure, args: 'on' })
    await f.clock.advance(2000)
    const registration = f.saved.get('tfx.pressure.session-a')
    await $.session.end({ reason: 'clear', sessionId: 'session-a', resume: { id: 'session-a' } })
    expect(f.saved.get('tfx.pressure.session-a')).toEqual(registration)
    if (!registered) f.saved.delete('tfx.pressure.session-a')
    f.data.sessionId = 'session-b'
    f.data.stdout = '4'
    await f.clock.advance(4000)
    expect(f.saved.has('tfx.pressure.session-a')).toBe(false)
    expect(f.saved.get('tfx.pressure.session-b')).toEqual(registered ? registration : undefined)
    expect(f.calls.filter(argv => argv[0] === 'sysctl').length).toBe(registered ? 3 : 1)
    expect(f.prompts.length).toBe(registered ? 1 : 0)
    if (registered) expect(f.prompts[0]).toContain('1 에서 4')
  })
}

test('1 에서 2 전이는 턴을 열지 않고 다음 요청에 한 줄로 한 번만 붙는다', async ($, on) => {
  const f = fixture(on)
  await confirmTransition($, f, '2')
  await f.clock.advance(2000)
  expect(f.peers).toEqual([])
  expect(f.prompts).toEqual([])
  await $.prompt.submit({ text: '다음 요청' })
  await $.prompt.submit({ text: '그다음 요청' })
  expect(f.contexts).toEqual([['메모리 압박: 현재 2(1970-01-01T00:00:06.000Z, 1 normal 2 warn 4 critical)'], undefined])
})

test('2 에서 4 전이는 피어 메시지로 깨운다', async ($, on) => {
  const f = fixture(on)
  f.data.stdout = '2'
  f.data.peer = { exitCode: 0, stdout: '{"status":"written","msgId":"m"}\n', stderr: '' }
  await confirmTransition($, f, '4')
  expect(f.peers.length).toBe(1)
  expect(f.peers[0][5]).toContain('2 에서 4 로 올랐다')
  expect(f.prompts).toEqual([])
})

test('1, 2, 1 로 오가면 리드 도구 결과에 마지막 상태 하나만 붙는다', async ($, on) => {
  const f = fixture(on)
  await confirmTransition($, f, '2')
  f.data.stdout = '1'
  await f.clock.advance(4000)
  expect(f.peers).toEqual([])
  expect((await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'sub' } as never)).context).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as never)).context).toEqual(['메모리 압박: 현재 1(1970-01-01T00:00:10.000Z, 1 normal 2 warn 4 critical)'])
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as never)).context).toBeUndefined()
})

for (const registered of [false, true]) {
  test(`비대화형 on은 ${registered ? '기존 등록을 바꾸지 않고' : '새 등록을 쓰지 않고'} 거부한다`, async ($, on) => {
    const f = fixture(on)
    if (registered) f.saved.set('tfx.pressure.session-a', { since: 'before' })
    await $.session.start({ ...start, surface: null, isInteractive: false })
    expect((await $.command.run({ ...pressure, args: 'on' })).text).toContain('대화형 세션에서만 지원')
    expect(f.saved.get('tfx.pressure.session-a')).toEqual(registered ? { since: 'before' } : undefined)
    await f.clock.advance(6000)
    expect(f.commands).toContain('tfx-pressure')
    expect(f.calls.filter(argv => argv[0] === 'sysctl')).toEqual([])
    expect(f.prompts).toEqual([])
  })
}

for (const reason of ['prompt_input_exit', 'resume', 'logout', 'other'] as const) {
  test(`${reason} 종료는 끝나는 세션의 등록만 지운다`, async ($, on) => {
    const f = fixture(on)
    f.saved.set('tfx.pressure.session-a', { since: 'before' })
    f.saved.set('tfx.pressure.session-b', { since: 'keep' })
    f.data.sessionId = 'session-b'
    expect(await $.session.end({ reason, sessionId: 'session-a', resume: { id: 'session-a' } })).toEqual({ sessionId: 'session-a' })
    expect(f.saved.has('tfx.pressure.session-a')).toBe(false)
    expect(f.saved.get('tfx.pressure.session-b')).toEqual({ since: 'keep' })
  })
}

test('macOS가 아니면 등록을 거부하고 측정하지 않는다', async ($, on) => {
  const f = fixture(on)
  f.data.platform = 'Linux\n'
  await $.session.start(start)
  expect((await $.command.run({ ...pressure, args: 'on' })).text).toContain('macOS 에서만 지원')
  await $.command.run({ ...pressure, args: 'on' })
  await f.clock.advance(6000)
  expect(f.saved.size).toBe(0)
  expect(f.calls).toEqual([['uname', '-s']])
})
