import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { leadSessionName } from '../hooks/lead-role.ts'

// leadSessionName 은 로컬 날짜를 쓰므로 픽스처도 로컬 시각으로 잡는다.
const noon = new Date(2026, 9, 21, 12).getTime()

test('역할 앞에 앞자리 0 없는 날짜를 붙이고 이미 붙어 있으면 그대로 둔다', () => {
  expect(leadSessionName('개발리드', new Date(2026, 2, 5, 12).getTime())).toBe('3.5 개발리드')
  expect(leadSessionName('9.3 프로젝트리드', noon)).toBe('9.3 프로젝트리드')
})

const start = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const
const lead = { command: 'tfx-lead', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

function fixture(
  on: On,
  rename: 'ok' | 'reject',
  uname?: Promise<void>,
  extraEnv: Record<string, string> = {},
  tmuxSession?: () => string,
) {
  const clock = mock.clock(on, { now: noon })
  mock.store(on)
  mock.env(on, { HOME: '/home/test', ...extraEnv })
  const renames: string[] = []
  const toasts: string[] = []
  const compacts: (string | undefined)[] = []
  on('session.id', () => ({ value: 'session-a' }))
  on('session.root', () => ({ value: '/work' }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.compact', (_, e) => { compacts.push(e.instructions); return { messages: [...e.messages] } })
  on('session.usage', () => ({ value: { context: { window: 1000, tokens: 0, percent: 0 }, rateLimits: [] } }) as never)
  on('process.run', async (_, e) => {
    if (e.argv[0] === 'tmux' && tmuxSession) {
      return {
        value: {
          exitCode: 0,
          stdout: `${tmuxSession()}\n`,
          stderr: '',
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    }
    if (e.argv[0] === 'uname') await uname
    return { value: { exitCode: 0, stdout: e.argv[0] === 'uname' ? 'Darwin\n' : '1\n',
      stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.write', () => ({ value: undefined }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__triflux-mods__${e.name}` } }))
  on('command.run', { command: 'rename' }, (_, e) => {
    renames.push(e.args)
    if (rename === 'reject') throw new Error('거부')
    return { text: e.args }
  })
  on('ui.toast', (_, e) => { toasts.push(e.text); return { value: undefined } })
  return { clock, renames, toasts, compacts }
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

test('압박 감시를 켜는 동안 시계가 흘러도 rename 은 명령이 끝난 뒤에만 호출한다', async ($, on) => {
  let release!: () => void
  const f = fixture(on, 'ok', new Promise<void>(done => { release = done }))
  await $.session.start(start)
  const pending = $.command.run({ ...lead, args: '개발리드' })
  await f.clock.advance(1000)
  expect(f.renames).toEqual([])
  release()
  await pending
  await f.clock.settle()
  expect(f.renames).toEqual(['10.21 개발리드'])
  expect(f.toasts).toEqual([])
})

test('--role communication 인자로 실행하면 소통 표지로 저장한다', async ($, on) => {
  const f = fixture(on, 'ok')
  on('fs.read', () => { throw new Error('ENOENT') })
  await $.session.start(start)
  const result = await $.command.run({ ...lead, args: '--role communication 소통창구' })
  await f.clock.settle()
  expect(f.renames).toEqual(['10.21 소통창구'])
  expect(result.text).toContain('이름 변경 요청: 10.21 소통창구')
  expect(result.context).toEqual([
    '이 세션은 소통창구 소통 세션을 맡는다. tfx-comm 스킬을 로드해 그 절차를 따른다.',
  ])
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: '작업', toolUses: [] }] })
  expect(f.compacts[0]).toContain('- 소통 역할: 소통창구, 세션 이름: 10.21 소통창구')
})

test('대화형 session.start 때 TMUX_PANE 과 일치하는 claude 표지를 읽어 소통 세션으로 등록하고 압박 감시를 켠다', async ($, on) => {
  const f = fixture(on, 'ok', undefined, { TMUX_PANE: '%15' })
  on('fs.list', (_, e) => {
    if (e.path === '/home/test/.local/state/triflux/lead-roles') {
      return { value: [{ name: 'app-comm.json', type: 'file' }] }
    }
    return { value: [] }
  })
  on('fs.read', (_, e) => {
    if (e.path === '/home/test/.local/state/triflux/lead-roles/app-comm.json') {
      return {
        value: JSON.stringify({
          session: 'app-comm',
          paneId: '%15',
          cli: 'claude',
          sessionRole: 'communication',
          role: '문서 소통',
          since: '2026-10-21T03:00:00.000Z',
        }),
      }
    }
    throw new Error('ENOENT')
  })
  await $.session.start(start)
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: '작업', toolUses: [] }] })
  expect(f.compacts[0]).toContain('- 소통 역할: 문서 소통, 세션 이름: 10.21 문서 소통')
  expect((await $.command.run({ ...lead, command: 'tfx-pressure', args: 'status' })).text).toContain('압박 감시: on')
  expect(f.toasts).toEqual([])
})

test('session.start 이후에 생성된 claude 표지도 다음 훅 시점에 지연 채택하고 재사용된 paneId 는 걸러낸다', async ($, on) => {
  let markerReady = false
  let liveSession = 'other-session'
  const f = fixture(
    on,
    'ok',
    undefined,
    { TMUX_PANE: '%21', TMUX: '/tmp/tmux-1/default,1,0' },
    () => liveSession,
  )
  on('fs.list', (_, e) => {
    if (markerReady && e.path === '/home/test/.local/state/triflux/lead-roles') {
      return { value: [{ name: 'app-comm.json', type: 'file' }] }
    }
    return { value: [] }
  })
  on('fs.read', (_, e) => {
    if (markerReady && e.path === '/home/test/.local/state/triflux/lead-roles/app-comm.json') {
      return {
        value: JSON.stringify({
          session: 'app-comm',
          paneId: '%21',
          cli: 'claude',
          sessionRole: 'communication',
          role: '지연 소통',
          since: '2026-10-21T03:00:00.000Z',
        }),
      }
    }
    throw new Error('ENOENT')
  })

  await $.session.start(start)
  markerReady = true
  // tmux 세션 이름이 다르면(재사용된 paneId) 채택하지 않는다.
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: '작업', toolUses: [] }] })
  expect(f.compacts[0]).not.toContain('지연 소통')

  // 실제 세션 이름이 일치하면 지연 생성된 표지를 채택하고 압박 감시를 켠다.
  liveSession = 'app-comm'
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: '작업', toolUses: [] }] })
  expect(f.compacts[1]).toContain('- 소통 역할: 지연 소통, 세션 이름: 10.21 지연 소통')
  expect((await $.command.run({ ...lead, command: 'tfx-pressure', args: 'status' })).text).toContain('압박 감시: on')
})
