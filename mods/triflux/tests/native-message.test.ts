import type { On, ProcessRunResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const sent = { ok: true, to: { cli: 'agy', name: '10.14 검토', target: 'cx:0.0' }, transport: 'tmux', status: 'sent' }
const missingResponse = { success: false, message: "No agent named 'zz-nonexistent-probe-1014' is reachable.\nUse ListAgents to see everyone you can message." }
const missing = { result: missingResponse, text: JSON.stringify(missingResponse), ref: 7 } as const
const listing = { result: { listing: 'Claude agents: reviewer', sections: [], notes: [] }, text: 'Claude agents: reviewer', ref: 8, context: ['keep'] }

function processStub(on: On, respond: (argv: readonly string[]) => unknown, exitCode = 0, stderr = '') {
  const calls: string[][] = []
  mock.env(on, { CLAUDE_PID: '123' })
  on('process.run', (_, e) => {
    calls.push([...e.argv])
    const value = respond(e.argv)
    return { value: { exitCode, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr, isStdoutTruncated: false, isStderrTruncated: false } satisfies ProcessRunResult }
  })
  return calls
}

for (const to of ['agy:10.14 검토', 'antigravity:10.14 검토']) {
  test(`${to} 는 원래 도구 없이 tfx-live send 로 전달한다`, async ($, on) => {
    let nativeCalls = 0
    on('tool.call', { tool: 'SendMessage' }, () => { nativeCalls++; return { result: 'native' } })
    const calls = processStub(on, () => ({ ...sent, to: { ...sent.to, cli: 'agy' }, transport: 'tmux' }))
    const message = '검토해줘\n$(touch /tmp/never) "따옴표"'
    const result = await $.tool.call({ tool: 'SendMessage', to, message })
    expect(nativeCalls).toBe(0)
    expect(calls).toEqual([['tfx-live', 'send', '--to', to, '--message', message, '--no-wait']])
    expect(result.result).toContain('agy:10.14 검토')
    expect(result.result).toContain('tmux')
    expect(result.deny).toBeUndefined()
  })
}

test('접두사 없는 성공은 원래 결과를 보존하고 프로세스를 실행하지 않는다', async ($, on) => {
  const native = { result: { success: true, message: 'Message sent to reviewer' }, ref: 5, text: 'native text' }
  on('tool.call', { tool: 'SendMessage' }, () => native)
  const calls = processStub(on, () => sent)
  expect(await $.tool.call({ tool: 'SendMessage', to: 'reviewer', message: '검토' })).toEqual(native)
  expect(calls).toEqual([])
})

test('없는 이름 오류 뒤에는 한 번만 send 를 시도한다', async ($, on) => {
  let nativeCalls = 0
  on('tool.call', { tool: 'SendMessage' }, () => { nativeCalls++; return missing })
  const calls = processStub(on, () => sent)
  const result = await $.tool.call({ tool: 'SendMessage', to: '10.14 검토', message: '검토' })
  expect(nativeCalls).toBe(1)
  expect(calls).toEqual([['tfx-live', 'send', '--to', 'agy:10.14 검토', '--message', '검토', '--no-wait']])
  expect(result.result).toContain('tmux')
  expect(result.isError).toBeUndefined()
})

for (const [kind, native] of [
  ['일반 결과', { result: missingResponse, ref: 7 }],
  ['오류 결과', { isError: true, result: "No agent named 'zz-nonexistent-probe-1014' is reachable.", ref: 7 }],
] as const) {
  test(`text 없는 ${kind}의 이름 오류도 send 를 시도한다`, async ($, on) => {
    on('tool.call', { tool: 'SendMessage' }, () => native)
    const calls = processStub(on, () => sent)
    const result = await $.tool.call({ tool: 'SendMessage', to: '10.14 검토', message: '검토' })
    expect(calls.length).toBe(1)
    expect(result.result).toContain('tmux')
  })
}


test('다른 native 오류는 재전송하지 않는다', async ($, on) => {
  const native = { isError: true, result: 'Permission denied', text: 'Permission denied' } as const
  on('tool.call', { tool: 'SendMessage' }, () => native)
  const calls = processStub(on, () => sent)
  expect(await $.tool.call({ tool: 'SendMessage', to: 'reviewer', message: '검토' })).toEqual(native)
  expect(calls).toEqual([])
})

for (const [to, status] of [['codex:10.14 검토', 'written'], ['Codex:10.14 검토', 'sent']]) {
  test(`${to} 는 tfx-live send 를 호출하지 않는다`, async ($, on) => {
    let nativeCalls = 0
    on('tool.call', { tool: 'SendMessage' }, () => { nativeCalls++; return { result: 'native' } })
    const calls = processStub(on, () => ({ status, retrySafe: false, modelReceipt: false }))
    const message = '검토해줘\n$(printf never) "따옴표"'
    const result = await $.tool.call({ tool: 'SendMessage', to, message })
    expect(calls).toEqual([['tfx-peer', 'send', '--to', 'codex:10.14 검토', '--message', message]])
    expect(result.result).toContain('codex:10.14 검토')
    expect(result.result).toContain('native peer')
    expect(result.result).toContain(status)
    expect(result.deny).toBeUndefined()
    expect(nativeCalls).toBe(0)
  })
}

for (const status of ['partial', 'unknown']) {
  test(`Codex ${status} 는 결과 불명으로 알리고 재전송하지 않는다`, async ($, on) => {
    let nativeCalls = 0
    on('tool.call', { tool: 'SendMessage' }, () => { nativeCalls++; return { result: 'native' } })
    const calls = processStub(on, () => ({ status, retrySafe: false, modelReceipt: false, error: '전송 결과 불확실' }), 2, 'stderr 보다 JSON 우선')
    const result = await $.tool.call({ tool: 'SendMessage', to: 'codex:10.14 검토', message: '검토' })
    expect(result.deny).toContain(status)
    expect(result.deny).toContain('결과 불명. 이미 들어갔을 수 있으니 재전송하지 말고 상대 회신을 확인하라')
    expect(result.deny).toContain('전송 결과 불확실')
    expect(calls.length).toBe(1)
    expect(nativeCalls).toBe(0)
  })
}

test('Codex exit 1 은 빈 stdout 대신 stderr 오류를 반환한다', async ($, on) => {
  let nativeCalls = 0
  on('tool.call', { tool: 'SendMessage' }, () => { nativeCalls++; return { result: 'native' } })
  const calls = processStub(on, () => '', 1, 'Codex target lacks exact thread provenance\n')
  const result = await $.tool.call({ tool: 'SendMessage', to: 'codex:10.14 검토', message: '검토' })
  expect(result.deny).toContain('Codex target lacks exact thread provenance')
  expect(calls.length).toBe(1)
  expect(nativeCalls).toBe(0)
})

for (const message of [{ type: 'shutdown_request', reason: '끝' }, { type: 'shutdown_response', request_id: 'r1', approve: true }, { type: 'plan_approval_response', request_id: 'r1', approve: false }, '{"type":"shutdown_request","reason":"끝"}']) {
  test(`구조화 메시지 ${JSON.stringify(message)} 는 그대로 통과한다`, async ($, on) => {
    const seen: unknown[] = []
    on('tool.call', { tool: 'SendMessage' }, (_, e) => { seen.push(e.message); return { result: 'native' } })
    const calls = processStub(on, () => sent)
    const result = await $.tool.call({ tool: 'SendMessage', to: 'codex:10.14 검토', message: message as never })
    expect(result.result).toBe('native')
    expect(seen).toEqual([message])
    expect(calls).toEqual([])
  })
}

for (const failure of ['missing-binary', 'timeout', 'invalid-json', 'invalid-status', 'truncated']) {
  test(`Codex ${failure} 은 오류를 반환하고 폴백하지 않는다`, async ($, on) => {
    let nativeCalls = 0
    let processCalls = 0
    on('tool.call', { tool: 'SendMessage' }, () => { nativeCalls++; return { result: 'native' } })
    mock.env(on, { CLAUDE_PID: '123' })
    on('process.run', () => {
      processCalls++
      if (failure === 'missing-binary' || failure === 'timeout') return { deny: failure === 'missing-binary' ? 'spawn tfx-peer ENOENT' : 'timeout' }
      return { value: { exitCode: 0, stdout: failure === 'invalid-json' ? 'not JSON' : JSON.stringify({ status: failure === 'invalid-status' ? 'completed' : 'sent' }), stderr: '', isStdoutTruncated: failure === 'truncated', isStderrTruncated: false } }
    })
    const result = await $.tool.call({ tool: 'SendMessage', to: 'codex:10.14 검토', message: '검토' })
    expect(result.deny).toContain(failure === 'missing-binary' ? '전송 실패:' : '결과 불명. 이미 들어갔을 수 있으니 재전송하지 말고 상대 회신을 확인하라')
    expect(nativeCalls).toBe(0)
    expect(processCalls).toBe(1)
  })
}

test('재시도 프로세스 실패도 원래 SendMessage 를 다시 실행하지 않는다', async ($, on) => {
  let nativeCalls = 0
  let processCalls = 0
  on('tool.call', { tool: 'SendMessage' }, () => { nativeCalls++; return missing })
  mock.env(on, { CLAUDE_PID: '123' })
  on('process.run', () => { processCalls++; return { deny: 'spawn tfx-live ENOENT' } })
  expect(await $.tool.call({ tool: 'SendMessage', to: '10.14 검토', message: '검토' })).toEqual(missing)
  expect(nativeCalls).toBe(1)
  expect(processCalls).toBe(1)
})

test('재시도 send 실패는 원래 결과를 보존한다', async ($, on) => {
  on('tool.call', { tool: 'SendMessage' }, () => missing)
  const calls = processStub(on, () => ({ ok: false, reason: 'ambiguous-target', error: '세션이 둘이다' }), 1)
  expect(await $.tool.call({ tool: 'SendMessage', to: '10.14 검토', message: '검토' })).toEqual(missing)
  expect(calls.length).toBe(1)
})

test('ListAgents 는 기존 목록 뒤에 로컬 Codex 와 agy 이름을 덧붙인다', async ($, on) => {
  on('tool.call', { tool: 'ListAgents' }, () => listing)
  const calls = processStub(on, argv => argv[3] === 'codex'
    ? { ok: true, cli: 'agy', cwd: null, sessions: [
        { session: 'cx', startedAt: '2026-10-14T12:00:00.000Z', startedAtEpoch: 1791979200, cwd: '/project', attached: true, target: 'cx:0.0', panes: [{ target: 'cx:0.0', cwd: '/project', command: 'codex', threadId: 'thread-1', name: '10.14 검토' }] },
        { session: 'cx-legacy', startedAt: null, startedAtEpoch: null, cwd: '/project', attached: false, target: 'cx-legacy:0.0', panes: [{ target: 'cx-legacy:0.0', cwd: '/project', command: 'codex' }] },
      ] }
    : { ok: true, cli: 'agy', cwd: null, sessions: [{ name: '10.14 구현', session: 'ag', target: 'ag:0.0', paneId: '%3', cwd: '/project', pid: 103, command: 'agy', conversationId: null }] })
  const result = await $.tool.call({ tool: 'ListAgents' })
  if (result.isError || result.deny !== undefined) throw new Error('ListAgents failed')
  expect(result.result.listing).toContain('Claude agents: reviewer')
  expect(result.result.listing).toContain('codex:10.14 검토')
  expect(result.result.listing).toContain('codex:cx-legacy')
  expect(result.result.listing).toContain('agy:10.14 구현')
  expect(result.context).toEqual(['keep'])
  expect(result.ref).toBeUndefined()
  expect(result.text).toBeUndefined()
  expect(calls).toEqual([['tfx-live', 'list-sessions', '--cli', 'codex'], ['tfx-live', 'list-sessions', '--cli', 'agy']])
})

for (const failure of ['missing-binary', 'exit-code', 'not-ok', 'invalid-json', 'empty']) {
  test(`ListAgents 의 ${failure} 는 원래 결과를 보존한다`, async ($, on) => {
    let nativeCalls = 0
    let processCalls = 0
    on('tool.call', { tool: 'ListAgents' }, () => { nativeCalls++; return listing })
    mock.env(on, { CLAUDE_PID: '123' })
    on('process.run', (_, e) => {
      processCalls++
      if (failure === 'missing-binary') throw new Error('ENOENT')
      const stdout = failure === 'invalid-json' && e.argv[3] === 'agy' ? 'not JSON' : JSON.stringify({ ok: failure !== 'not-ok' || e.argv[3] !== 'agy', sessions: failure === 'empty' ? [] : [{ name: '10.14 검토' }] })
      return { value: { exitCode: failure === 'exit-code' && e.argv[3] === 'agy' ? 1 : 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    expect(await $.tool.call({ tool: 'ListAgents' })).toEqual(listing)
    expect(nativeCalls).toBe(1)
    expect(processCalls).toBe(failure === 'missing-binary' ? 1 : 2)
  })
}

for (const to of ['claude:missing', 'Claude:missing']) {
  test(`${to} 이름 오류는 agy 폴백하지 않는다`, async ($, on) => {
    on('tool.call', { tool: 'SendMessage' }, () => missing)
    const calls = processStub(on, () => sent)
    expect(await $.tool.call({ tool: 'SendMessage', to, message: '검토' })).toEqual(missing)
    expect(calls).toEqual([])
  })
}

test('agy 전송 실패는 후보 목록을 알린다', async ($, on) => {
  const calls = processStub(on, () => ({ ok: false, reason: 'ambiguous-target', candidates: [
    { cli: 'agy', name: '검토', target: 'ag:0.0' }, { cli: 'agy', name: '검토', target: 'ag:0.1' },
  ] }), 1)
  const result = await $.tool.call({ tool: 'SendMessage', to: 'agy:검토', message: '검토' })
  expect(result.deny).toContain('agy:검토 (ag:0.0), agy:검토 (ag:0.1)')
  expect(calls.length).toBe(1)
})

test('전송 프로세스에 Claude 환경과 제한 시간을 넘긴다', async ($, on) => {
  mock.env(on, { CLAUDE_PID: '123' })
  on('process.run', (_, e) => {
    expect(e.init?.env).toEqual({ CLAUDECODE: '1', CLAUDE_PID: '123' })
    expect(e.init?.timeoutMs).toBe(30_000)
    return { value: { exitCode: 0, stdout: '{"status":"sent"}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  expect((await $.tool.call({ tool: 'SendMessage', to: 'codex:target', message: '본문' })).deny).toBeUndefined()
})

for (const to of ['agy:target', 'missing']) {
  test(`${to} 전송 timeout 은 결과 불명으로 알리고 다시 보내지 않는다`, async ($, on) => {
    let nativeCalls = 0
    let processCalls = 0
    on('tool.call', { tool: 'SendMessage' }, () => { nativeCalls++; return missing })
    mock.env(on, { CLAUDE_PID: '123' })
    on('process.run', () => { processCalls++; return { deny: 'process timeoutMs exceeded' } })
    const result = await $.tool.call({ tool: 'SendMessage', to, message: '검토' })
    expect(result.deny).toContain('결과 불명. 이미 들어갔을 수 있으니 재전송하지 말고 상대 회신을 확인하라')
    expect(nativeCalls).toBe(to === 'missing' ? 1 : 0)
    expect(processCalls).toBe(1)
  })
}
