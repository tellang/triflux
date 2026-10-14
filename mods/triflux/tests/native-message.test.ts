import type { On, ProcessRunResult } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const sent = { ok: true, to: { cli: 'codex', name: '10.14 검토', target: 'cx:0.0' }, transport: 'queue', status: 'sent' }
const missing = { isError: true, result: "No agent named '@10.14 검토' is currently addressable.", text: "No agent named '@10.14 검토' is currently addressable.", ref: 7 } as const
const listing = { result: { listing: 'Claude agents: reviewer', sections: [], notes: [] }, text: 'Claude agents: reviewer', ref: 8, context: ['keep'] }

function processStub(on: On, respond: (argv: readonly string[]) => unknown, exitCode = 0) {
  const calls: string[][] = []
  on('process.run', (_, e) => {
    calls.push([...e.argv])
    const value = respond(e.argv)
    return { value: { exitCode, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } satisfies ProcessRunResult }
  })
  return calls
}

for (const to of ['codex:10.14 검토', 'agy:10.14 검토', 'antigravity:10.14 검토']) {
  test(`${to} 는 원래 도구 없이 tfx-live send 로 전달한다`, async ($, on) => {
    let nativeCalls = 0
    on('tool.call', { tool: 'SendMessage' }, () => { nativeCalls++; return { result: 'native' } })
    const cli = to.startsWith('codex:') ? 'codex' : 'agy'
    const calls = processStub(on, () => ({ ...sent, to: { ...sent.to, cli }, transport: cli === 'codex' ? 'queue' : 'tmux' }))
    const message = '검토해줘\n$(touch /tmp/never) "따옴표"'
    const result = await $.tool.call({ tool: 'SendMessage', to, message })
    expect(nativeCalls).toBe(0)
    expect(calls).toEqual([['tfx-live', 'send', '--to', to, '--message', message, '--no-wait']])
    expect(result.result).toContain(`${cli}:10.14 검토`)
    expect(result.result).toContain(cli === 'codex' ? 'queue' : 'tmux')
    expect(result.deny).toBeUndefined()
  })
}

test('접두사 없는 성공은 원래 결과를 보존하고 프로세스를 실행하지 않는다', async ($, on) => {
  const native = { result: 'Message sent to reviewer', ref: 5, text: 'native text' }
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
  expect(calls).toEqual([['tfx-live', 'send', '--to', '10.14 검토', '--message', '검토', '--no-wait']])
  expect(result.result).toContain('queue')
  expect(result.isError).toBeUndefined()
})

test('Claude 대상의 use-send-message 거부는 원래 오류를 보존한다', async ($, on) => {
  on('tool.call', { tool: 'SendMessage' }, () => missing)
  const calls = processStub(on, () => ({ ok: false, reason: 'use-send-message', error: 'Use SendMessage' }))
  expect(await $.tool.call({ tool: 'SendMessage', to: '10.14 검토', message: '검토' })).toEqual(missing)
  expect(calls.length).toBe(1)
})

test('다른 native 오류는 재전송하지 않는다', async ($, on) => {
  const native = { isError: true, result: 'Permission denied', text: 'Permission denied' } as const
  on('tool.call', { tool: 'SendMessage' }, () => native)
  const calls = processStub(on, () => sent)
  expect(await $.tool.call({ tool: 'SendMessage', to: 'reviewer', message: '검토' })).toEqual(native)
  expect(calls).toEqual([])
})

test('전송 실패는 이유와 후보 목록을 오류 결과로 돌려준다', async ($, on) => {
  on('tool.call', { tool: 'SendMessage' }, () => ({ result: 'native' }))
  const calls = processStub(on, () => ({ ok: false, reason: 'ambiguous-target', error: '세션이 둘이다', candidates: [{ cli: 'codex', name: '10.14 검토', target: 'cx:0.0' }, { cli: 'codex', name: '10.14 검토', target: 'cx:1.0' }] }), 1)
  const result = await $.tool.call({ tool: 'SendMessage', to: 'codex:10.14 검토', message: '검토' })
  expect(result.deny).toContain('ambiguous-target')
  expect(result.deny).toContain('세션이 둘이다')
  expect(result.deny).toContain('cx:0.0')
  expect(result.deny).toContain('cx:1.0')
  expect(calls.length).toBe(1)
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

for (const failure of ['missing-binary', 'timeout', 'invalid-json']) {
  test(`${failure} 이면 원래 SendMessage 를 한 번 실행한다`, async ($, on) => {
    let nativeCalls = 0
    let processCalls = 0
    on('tool.call', { tool: 'SendMessage' }, () => { nativeCalls++; return { result: 'native' } })
    on('process.run', () => {
      processCalls++
      if (failure !== 'invalid-json') throw new Error(failure)
      return { value: { exitCode: 0, stdout: 'not JSON', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    expect((await $.tool.call({ tool: 'SendMessage', to: 'codex:10.14 검토', message: '검토' })).result).toBe('native')
    expect(nativeCalls).toBe(1)
    expect(processCalls).toBe(1)
  })
}

test('재시도 프로세스 실패도 원래 SendMessage 를 다시 실행하지 않는다', async ($, on) => {
  let nativeCalls = 0
  let processCalls = 0
  on('tool.call', { tool: 'SendMessage' }, () => { nativeCalls++; return missing })
  on('process.run', () => { processCalls++; throw new Error('missing-binary') })
  expect(await $.tool.call({ tool: 'SendMessage', to: '10.14 검토', message: '검토' })).toEqual(missing)
  expect(nativeCalls).toBe(1)
  expect(processCalls).toBe(1)
})

test('ListAgents 는 기존 목록 뒤에 로컬 Codex 와 agy 이름을 덧붙인다', async ($, on) => {
  on('tool.call', { tool: 'ListAgents' }, () => listing)
  const calls = processStub(on, argv => argv[3] === 'codex'
    ? { ok: true, cli: 'codex', cwd: null, sessions: [
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
