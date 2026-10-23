import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { controlTool } from '../hooks/control.ts'

function fixture(on: On, options: { reject?: boolean; files?: string[] } = {}) {
  const clock = mock.clock(on)
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
  return { clock, commands, prompts }
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
