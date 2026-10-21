import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { leadSessionName } from '../hooks/lead-role.ts'

const noon = Date.UTC(2026, 9, 21, 12)

test('역할 앞에 앞자리 0 없는 날짜를 붙이고 이미 붙어 있으면 그대로 둔다', () => {
  expect(leadSessionName('개발리드', Date.UTC(2026, 2, 5, 12))).toBe('3.5 개발리드')
  expect(leadSessionName('9.3 프로젝트리드', noon)).toBe('9.3 프로젝트리드')
})

const start = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const
const lead = { command: 'tfx-lead', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

function fixture(on: On, rename: 'ok' | 'reject') {
  const clock = mock.clock(on, { now: noon })
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  const renames: string[] = []
  const toasts: string[] = []
  on('session.id', () => ({ value: 'session-a' }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.usage', () => ({ value: { context: { window: 1000, tokens: 0, percent: 0 }, rateLimits: [] } }) as never)
  on('process.run', (_, e) => ({ value: { exitCode: 0, stdout: e.argv[0] === 'uname' ? 'Darwin\n' : '1\n',
    stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.write', () => ({ value: undefined }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('command.run', { command: 'rename' }, (_, e) => {
    renames.push(e.args)
    if (rename === 'reject') throw new Error('거부')
    return { text: e.args }
  })
  on('ui.toast', (_, e) => { toasts.push(e.text); return { value: undefined } })
  return { clock, renames, toasts }
}

test('인자가 없으면 사용법만 돌려주고 이름을 바꾸지 않는다', async ($, on) => {
  const f = fixture(on, 'ok')
  await $.session.start(start)
  const result = await $.command.run({ ...lead, args: '  ' })
  await f.clock.settle()
  expect(result.text).toBe('사용법: /tfx-lead <역할>')
  expect(result.context).toBeUndefined()
  expect(f.renames).toEqual([])
})

test('역할을 받으면 이름 변경을 요청하고 압박 감시를 켜고 리드 지시를 넣는다', async ($, on) => {
  const f = fixture(on, 'ok')
  await $.session.start(start)
  const result = await $.command.run({ ...lead, args: '개발리드' })
  await f.clock.settle()
  expect(f.renames).toEqual(['10.21 개발리드'])
  expect(result.text).toBe('이름 변경 요청: 10.21 개발리드. 메모리 압박 감시: on')
  expect(result.context).toEqual(['이 세션의 리드 역할은 개발리드이다. tfx-lead 스킬을 로드해 그 절차를 따른다.'])
  expect(f.toasts).toEqual([])
  expect((await $.command.run({ ...lead, command: 'tfx-pressure', args: 'status' })).text).toContain('압박 감시: on')
})

test('rename 이 거부되면 직접 실행하라는 토스트를 띄우고 나머지는 그대로 한다', async ($, on) => {
  const f = fixture(on, 'reject')
  await $.session.start(start)
  const result = await $.command.run({ ...lead, args: '개발리드' })
  await f.clock.settle()
  expect(f.renames).toEqual(['10.21 개발리드'])
  expect(f.toasts).toEqual(['이름 변경 실패: /rename 10.21 개발리드 을 직접 실행'])
  expect(result.context?.length).toBe(1)
  expect(result.text).toContain('메모리 압박 감시: on')
})
