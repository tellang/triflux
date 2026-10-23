import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { controlTool } from '../hooks/control.ts'

type Options = { reject?: boolean; files?: string[]; isLead?: boolean }

function fixture(on: On, options: Options = {}) {
  const clock = mock.clock(on)
  mock.store(on, options.isLead === false ? {} : { 'tfx.lead.lead-1': { role: '개발리드', since: '2026-10-23T00:00:00.000Z' } })
  const session = { id: 'lead-1' }
  on('session.id', () => ({ value: session.id }))
  const commands: string[] = []
  const prompts: string[] = []
  on('fs.exists', (_, e) => ({ value: (options.files ?? []).includes(e.path) }))
  for (const command of ['compact', 'clear', 'exit']) {
    on('command.run', { command }, (_, e) => {
      commands.push(`/${e.command} ${e.args}`.trim())
      if (options.reject) throw new Error('거부')
      return { text: '' }
    })
  }
  on('prompt.submit', (_, e) => { prompts.push(e.text); return { text: e.text } })
  return { clock, commands, prompts, session }
}

test('exit 는 handoff 가 없으면 거부하고 아무것도 실행하지 않는다', async ($, on) => {
  const f = fixture(on)
  const result = await $.tool.call({ tool: controlTool, action: 'exit' })
  await f.clock.settle()
  expect(result.deny).toContain('handoff')
  expect(f.commands).toEqual([])
})

test('없는 인계 파일은 실행 전에 거부한다', async ($, on) => {
  const f = fixture(on)
  const result = await $.tool.call({ tool: controlTool, action: 'clear', handoff: '/work/handoff.md' })
  await f.clock.settle()
  expect(result.deny).toContain('/work/handoff.md')
  expect(f.commands).toEqual([])
})

test('compact 는 지시문을 넘기고 끝난 뒤 then 을 넣는다', async ($, on) => {
  const f = fixture(on)
  const result = await $.tool.call({ tool: controlTool, action: 'compact', instructions: '계획만 남겨', then: '다음 단계 진행' })
  expect(result.deny).toBeUndefined()
  expect(f.commands).toEqual([])
  await f.clock.settle()
  expect(f.commands).toEqual(['/compact 계획만 남겨'])
  expect(f.prompts).toEqual(['다음 단계 진행'])
})

test('clear 뒤에는 인계 파일을 읽으라는 줄을 then 보다 먼저 넣는다', async ($, on) => {
  const f = fixture(on, { files: ['/work/handoff.md'] })
  await $.tool.call({ tool: controlTool, action: 'clear', handoff: '/work/handoff.md', then: '리뷰 이어서' })
  await f.clock.settle()
  expect(f.commands).toEqual(['/clear'])
  expect(f.prompts).toEqual(['인계 파일 /work/handoff.md 를 읽고 이어간다.\n리뷰 이어서'])
})

test('호스트가 슬래시 실행을 거부하면 다음 턴 prompt 로 실패를 알린다', async ($, on) => {
  const f = fixture(on, { reject: true, files: ['/work/handoff.md'] })
  await $.tool.call({ tool: controlTool, action: 'exit', handoff: '/work/handoff.md' })
  await f.clock.settle()
  expect(f.commands).toEqual(['/exit'])
  expect(f.prompts.length).toBe(1)
  expect(f.prompts[0]).toContain('/exit 실패')
})

test('서브에이전트가 부르면 리드 세션을 건드리지 않고 거부한다', async ($, on) => {
  const f = fixture(on)
  const result = await $.tool.call({ tool: controlTool, action: 'compact', agentId: 'a1' })
  await f.clock.settle()
  expect(result.deny).toContain('서브에이전트')
  expect(f.commands).toEqual([])
})

test('리드가 아닌 세션은 /tfx-lead 를 먼저 실행하라며 거부한다', async ($, on) => {
  const f = fixture(on, { isLead: false })
  const result = await $.tool.call({ tool: controlTool, action: 'compact' })
  await f.clock.settle()
  expect(result.deny).toContain('/tfx-lead')
  expect(f.commands).toEqual([])
})

test('/clear 로 세션 ID 가 바뀌어도 리드 권한이 이어진다', async ($, on) => {
  const f = fixture(on, { isLead: false })
  on('command.run', { command: 'rename' }, (_, e) => ({ text: e.args }))
  await $.command.run({ command: 'tfx-lead', args: '개발리드', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  f.session.id = 'lead-2'
  const result = await $.tool.call({ tool: controlTool, action: 'compact' })
  await f.clock.settle()
  expect(result.deny).toBeUndefined()
  expect(f.commands).toContain('/compact')
})

function processStub(on: On, fail = false, sessions: unknown[] = []) {
  const calls: string[][] = []
  on('process.run', (_, e) => {
    calls.push([...e.argv])
    const stdout = e.argv[1] === 'list-sessions' ? JSON.stringify({ ok: true, sessions }) : '{}'
    const exitCode = fail && e.argv[1] !== 'list-sessions' ? 1 : 0
    return { value: { exitCode, stdout, stderr: exitCode ? 'no tmux session' : '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return calls
}

test('서브에이전트 대상은 대안을 담은 오류로 돌려주고 아무것도 실행하지 않는다', async ($, on) => {
  fixture(on)
  const calls = processStub(on)
  const result = await $.tool.call({ tool: controlTool, target: 'subagent:reviewer', action: 'exit' })
  expect(result.deny).toContain('TaskStop')
  expect(calls).toEqual([])
})

test('agy compact 는 지원하지 않는다고 돌려준다', async ($, on) => {
  fixture(on)
  const calls = processStub(on)
  const result = await $.tool.call({ tool: controlTool, target: 'agy:ag1', action: 'compact' })
  expect(result.deny).toContain('agy 는 compact 가 없다')
  expect(calls).toEqual([])
})

test('Codex clear 는 tmux 로 /new 를 보내고 인계 줄과 then 을 뒤이어 보낸다', async ($, on) => {
  fixture(on, { files: ['/work/h.md'] })
  const calls = processStub(on)
  const result = await $.tool.call({ tool: controlTool, target: 'codex:cx1', action: 'clear', handoff: '/work/h.md', then: '리뷰 시작' })
  expect(result.deny).toBeUndefined()
  expect(calls).toEqual([
    ['tfx-live', 'ask', '--cli', 'codex', '--session', 'cx1', '--prompt', '/new', '--no-wait'],
    ['tfx-live', 'ask', '--cli', 'codex', '--session', 'cx1', '--prompt', '인계 파일 /work/h.md 를 읽고 이어간다.\n리뷰 시작', '--no-wait'],
  ])
})

test('tmux 경로가 실패하면 이유를 도구 오류로 돌려준다', async ($, on) => {
  fixture(on)
  processStub(on, true)
  const result = await $.tool.call({ tool: controlTool, target: 'codex:gone', action: 'exit' })
  expect(result.deny).toContain('no tmux session')
  expect(result.deny).toContain('tmux 로 띄운 세션만')
})

test('tmux 의 Claude 는 tfx-live 로, 밖의 Claude 는 표식 피어 메시지로 보낸다', async ($, on) => {
  fixture(on)
  const calls = processStub(on, false, [{ session: 'cl1', name: '10.23 워커' }])
  const sends: { to: unknown; text: string }[] = []
  on('session.send', (_, e) => { sends.push({ to: e.to, text: e.text }); return { isDelivered: true } })
  await $.tool.call({ tool: controlTool, target: 'claude:10.23 워커', action: 'compact', instructions: '요약' })
  expect(calls[1]).toEqual(['tfx-live', 'compact', '--cli', 'claude', '--session', 'cl1', '--instructions', '요약', '--no-wait'])
  const result = await $.tool.call({ tool: controlTool, target: 'claude:bg 워커', action: 'clear', then: '다음' })
  expect(result.deny).toBeUndefined()
  expect(sends).toEqual([{ to: 'bg 워커', text: '[tfx-control] {"action":"clear","then":"다음","from":"lead-1"}' }])
})

test('받는 쪽은 표식 피어 메시지만 가져가 실행하고 실패를 보낸 세션에 알린다', async ($, on) => {
  const f = fixture(on, { reject: true })
  const sends: { to: unknown; text: string }[] = []
  on('session.send', (_, e) => { sends.push({ to: e.to, text: e.text }); return { isDelivered: true } })
  on('session.receive', (_, e) => ({ text: e.text }))
  const plain = await $.session.receive({ origin: { kind: 'peer' }, text: '[tfx-control] 은 표식이 아니다' })
  expect(plain.text).toBe('[tfx-control] 은 표식이 아니다')
  const marked = await $.session.receive({ origin: { kind: 'peer' }, text: '[tfx-control] {"action":"compact","instructions":"짧게","from":"lead-1"}' })
  expect(marked.consumed).toBe('tfx-control')
  await f.clock.settle()
  expect(f.commands).toEqual(['/compact 짧게'])
  expect(sends.length).toBe(1)
  expect(sends[0]?.text).toContain('/compact 실패')
  expect(f.prompts).toEqual([])
})
