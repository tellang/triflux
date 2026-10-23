import type { EngineInterface, On, ToolCallResult } from 'claude-code'

import { type Lead, leadOf } from './lead-role.ts'

export const controlTool = 'mcp__triflux-mods__tfx_control'
// 받는 쪽 mod 가 알아보는 피어 메시지 표식. 이 줄로 시작하지 않는 피어 메시지는 건드리지 않는다.
export const controlMarker = '[tfx-control]'

const actions = ['compact', 'clear', 'exit'] as const
type Action = (typeof actions)[number]
type Request = { target?: string; action?: string; instructions?: string; then?: string; handoff?: string }
type Delivered = Request & { from?: string }

const description = [
  '리드 세션 자신이나 리드가 띄운 세션에 /compact, /clear, /exit 를 건다. 모델은 내장 슬래시 명령을 직접 실행하지 못하므로 이 도구가 대신 실행한다.',
  '/tfx-lead <역할> 을 실행한 리드 세션에서만 받는다.',
  'target: self(기본), claude:<이름>, codex:<tmux 세션>, agy:<tmux 세션>, subagent:<이름>. 지원하지 않는 조합은 이유와 대안을 오류로 돌려준다.',
  'self 는 예약만 하고 실제 실행은 이 턴이 끝난 뒤다. 그러니 호출한 다음 응답을 짧게 마친다.',
  'compact: instructions 는 요약 지시문, then 은 압축 뒤 넣을 다음 프롬프트.',
  'clear: 전에 handoff 파일을 써 두고 경로를 넘기면 clear 뒤 그 파일을 읽으라는 줄과 then 을 차례로 넣는다.',
  'exit: self 는 handoff 파일 경로가 필수다. 사용자가 끝내라고 했거나 승계 세션이 인계 파일을 받기로 한 경우에만 쓴다.',
].join(' ')

const inputSchema = {
  type: 'object',
  properties: {
    target: { type: 'string', description: 'self, claude:<이름>, codex:<tmux 세션>, agy:<tmux 세션>, subagent:<이름>', default: 'self' },
    action: { type: 'string', enum: actions },
    instructions: { type: 'string', description: 'compact 지시문' },
    then: { type: 'string', description: 'compact 나 clear 뒤 넣을 다음 프롬프트' },
    handoff: { type: 'string', description: 'clear, exit 전에 써 둔 인계 파일 경로. self 의 exit 는 필수' },
  },
  required: ['action'],
}

const subagentAlternative = '서브에이전트에는 슬래시 입력창이 없고 mod API 에도 서브에이전트를 압축하거나 멈추는 함수가 없다. 끝내기: 결과를 받은 뒤 닫는다(백그라운드는 TaskStop, 팀원은 SendMessage 로 shutdown_request). 문맥 줄이기: 요약을 넘겨 새 서브에이전트를 띄운다.'

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function followUp(action: Action, e: Request) {
  const lines = [action === 'clear' && e.handoff ? `인계 파일 ${e.handoff} 를 읽고 이어간다.` : '', e.then ?? '']
  return lines.filter(Boolean).join('\n')
}

async function refuse($: EngineInterface, e: Request, agentId?: string) {
  if (!actions.includes(e.action as Action)) return `action 은 ${actions.join(', ')} 중 하나다.`
  const target = e.target ?? 'self'
  if (target === 'self' && agentId) return '서브에이전트는 리드 세션을 제어할 수 없다.'
  if (target === 'self' && e.action === 'exit' && !e.handoff) return 'exit 는 handoff 가 필요하다. 인계 파일을 먼저 쓰고 그 경로를 넘긴다.'
  if (target.startsWith('subagent:')) return subagentAlternative
  if (target !== 'self' && !/^(?:claude|codex|agy):./.test(target))
    return `지원하지 않는 대상: ${target}. self, claude:<이름>, codex:<tmux 세션>, agy:<tmux 세션> 중 하나다.`
  if (target.startsWith('agy:') && e.action === 'compact') return 'agy 는 compact 가 없다. clear 를 쓰거나 handoff 뒤 새 세션으로 넘긴다.'
  if (target.startsWith('codex:') && e.action === 'compact' && e.instructions) return 'Codex compact 는 지시문을 받지 않는다. instructions 를 빼고 then 에 싣는다.'
  if (e.handoff && !(await $.fs.exists(e.handoff))) return `인계 파일이 없다: ${e.handoff}. 먼저 쓴 뒤 다시 호출한다.`
}

// 자기 세션에 슬래시를 실행한다. 실패는 notify 로, 없으면 자기 세션 prompt 로 알린다.
async function run($: EngineInterface, action: Action, e: Delivered) {
  try {
    await $.command.run({ command: action, args: action === 'compact' ? (e.instructions ?? '') : '' })
  } catch (error) {
    const text = `[tfx_control] /${action} 실패: ${errorText(error)}.`
    if (e.from) await $.session.send({ to: { sessionId: e.from }, text })
    else await $.prompt.submit({ text: `${text} 사용자에게 /${action} 직접 입력을 요청한다.` })
    return
  }
  const text = followUp(action, e)
  if (action !== 'exit' && text) await $.prompt.submit({ text })
}

async function tfxLive($: EngineInterface, argv: string[]) {
  const process = await $.process.run(['tfx-live', ...argv], { stdin: '', timeoutMs: 120_000, env: { CLAUDECODE: '1' } })
  if (process.exitCode !== 0) throw new Error((process.stderr.trim() || process.stdout.trim() || `exit ${process.exitCode}`).slice(0, 500))
  return process.stdout
}

async function controlTmux($: EngineInterface, cli: string, session: string, action: Action, e: Request) {
  // Claude 가 로컬 Claude 에 ask 하면 tfx-live 가 SendMessage 를 쓰라며 거부하므로 tmux 입력을 명시한다.
  const ask = (prompt: string) => ['ask', '--cli', cli, '--session', session, '--prompt', prompt, '--no-wait', ...(cli === 'claude' ? ['--via-tmux'] : [])]
  if (action === 'exit') await tfxLive($, ['stop', '--cli', cli, '--session', session])
  else if (action === 'compact')
    await tfxLive($, ['compact', '--cli', cli, '--session', session, ...(e.instructions ? ['--instructions', e.instructions] : []), ...(e.then ? ['--then', e.then] : []), '--no-wait'])
  else {
    await tfxLive($, ask(cli === 'codex' ? '/new' : '/clear'))
    const text = followUp(action, e)
    if (text) await tfxLive($, ask(text))
  }
  return { result: `${cli}:${session} 에 tmux 로 ${action} 를 보냈다.` }
}

async function controlClaude($: EngineInterface, name: string, action: Action, e: Request): Promise<ToolCallResult> {
  const listed = await tfxLive($, ['list-sessions', '--cli', 'claude']).catch(() => '{}')
  const sessions: { session: string; name?: string }[] = JSON.parse(listed).sessions ?? []
  const tmux = sessions.find(entry => entry.name === name || entry.session === name)
  if (tmux) return controlTmux($, 'claude', tmux.session, action, e)
  const body: Delivered = { action, instructions: e.instructions, then: e.then, handoff: e.handoff, from: await $.session.id() }
  const sent = await $.session.send({ to: name, text: `${controlMarker} ${JSON.stringify(body)}` })
  if (!sent.isDelivered) return { deny: `claude:${name} 전송 실패: ${sent.reason}` }
  return { result: `claude:${name} 에 표식 피어 메시지로 ${action} 를 보냈다. 받는 쪽 triflux mod 가 그 세션 턴이 끝난 뒤 실행하고, 실패하면 이 세션에 알린다. 받는 쪽에 mod 가 없으면 일반 텍스트로 읽힌다.` }
}

export function registerControl(on: On, lead: Lead) {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    await $.tool.register({ name: 'tfx_control', description, inputSchema, isDeferred: false })
    return next(e)
  })
  on('tool.call', { tool: controlTool }, async ($, e) => {
    if (!(await leadOf($, lead))) return { deny: '이 세션은 리드가 아니다. /tfx-lead <역할> 을 먼저 실행한다.' }
    const request = e as Request
    const reason = await refuse($, request, e.agentId)
    if (reason) return { deny: reason }
    const action = request.action as Action
    const target = request.target ?? 'self'
    const cli = target.split(':', 1)[0] ?? target
    const name = target.slice(cli.length + 1)
    if (cli === 'self') {
      // 이 훅이 도는 동안의 $.command.run 은 거부되므로 마지막 await 뒤에 타이머를 건다.
      $.clock.after(0, () => run($, action, request)
        .catch(error => $.ui.toast(`[tfx_control] /${action} 결과 알림 실패: ${errorText(error)}`)))
      return { result: `/${action} 예약: 이 턴이 끝나면 실행한다. 응답을 짧게 마친다.` }
    }
    try {
      return cli === 'claude' ? await controlClaude($, name, action, request) : await controlTmux($, cli, name, action, request)
    } catch (error) {
      const hint = cli === 'claude' ? '' : ` ${cli} 는 tmux 로 띄운 세션만 제어한다.`
      return { deny: `${cli}:${name} ${action} 실패: ${errorText(error)}.${hint}` }
    }
  })
  on('session.receive', async ($, e, next) => {
    const json = /^\[tfx-control\] (\{.*\})$/m.exec(e.text)?.[1]
    if (e.origin.kind !== 'peer' || e.agentId || !json) return next(e)
    let body: Delivered
    try {
      body = JSON.parse(json)
    } catch {
      return next(e)
    }
    if (!actions.includes(body.action as Action)) return next(e)
    $.clock.after(0, () => run($, body.action as Action, body))
    return { consumed: 'tfx-control' }
  })
}
