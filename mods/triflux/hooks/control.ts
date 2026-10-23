import type { EngineInterface, On, ToolCallResult } from 'claude-code'

import { type Holder, leadOf, leadSessionName, sessionMark } from './lead-role.ts'

export const controlTool = 'mcp__triflux-mods__tfx_control'
// 받는 쪽 mod 가 알아보는 피어 메시지 표식. triflux mod 가 보낸, 본문 전체가 표식 한 줄인 피어 메시지만 본다.
export const controlMarker = '[tfx-control]'
// 받는 쪽이 저장한 자기를 띄운 리드 세션 ID. tfx-live start --lead-session 이 TFX_LEAD_SESSION_ID 로 넘긴다.
const boundKey = 'tfx.control.lead.'

const slashes = ['compact', 'clear', 'exit'] as const
const actions = [...slashes, 'whoami', 'rebind'] as const
type Slash = (typeof slashes)[number]
type Action = (typeof actions)[number]
type Request = { target?: string; action?: string; instructions?: string; then?: string; handoff?: string; lead?: string }
type Delivered = Request & { from?: string; leadName?: string }
type Bound = { lead: string }

const description = [
  '리드 세션 자신이나 리드가 띄운 세션에 /compact, /clear, /exit 를 건다. 모델은 내장 슬래시 명령을 직접 실행하지 못하므로 이 도구가 대신 실행한다.',
  '/tfx-lead <역할> 을 실행한 리드 세션의 메인 대화에서만 받는다.',
  'target: self(기본), claude:<이름>, codex:<tmux 세션>, agy:<tmux 세션>, subagent:<이름>. 지원하지 않는 조합은 이유와 대안을 오류로 돌려준다.',
  'self 는 예약만 하고 실제 실행은 이 턴이 끝난 뒤다. 그러니 호출한 다음 응답을 짧게 마친다.',
  'compact: instructions 는 요약 지시문, then 은 압축 뒤 넣을 다음 프롬프트.',
  'clear: 전에 handoff 파일을 써 두고 경로를 넘기면 clear 뒤 그 파일을 읽으라는 줄과 then 을 차례로 넣는다.',
  'exit: handoff 파일 경로가 필수다(tmux 로 보내는 Codex, agy, Claude 는 빼고). 사용자가 끝내라고 했거나 승계 세션이 인계 파일을 받기로 한 경우에만 쓴다.',
  'whoami: 이 세션의 sessionId 와 name 을 돌려준다. tfx-live start --lead-session 에 넘긴다.',
  'rebind: 승계 때 claude:<이름> 워커의 묶인 리드를 lead(새 리드 세션 ID)로 바꾼다. 지금 묶인 리드만 보낼 수 있다.',
].join(' ')

const inputSchema = {
  type: 'object',
  properties: {
    target: { type: 'string', description: 'self, claude:<이름>, codex:<tmux 세션>, agy:<tmux 세션>, subagent:<이름>', default: 'self' },
    action: { type: 'string', enum: actions },
    instructions: { type: 'string', description: 'compact 지시문' },
    then: { type: 'string', description: 'compact 나 clear 뒤 넣을 다음 프롬프트' },
    handoff: { type: 'string', description: 'clear, exit 전에 써 둔 인계 파일 경로. self 와 피어 경로 Claude 의 exit 는 필수' },
    lead: { type: 'string', description: 'rebind 의 새 리드 세션 ID' },
  },
  required: ['action'],
}

const subagentAlternative = '서브에이전트에는 슬래시 입력창이 없고 mod API 에도 서브에이전트를 압축하거나 멈추는 함수가 없다. 끝내기: 결과를 받은 뒤 닫는다(백그라운드는 TaskStop, 팀원은 tfx-lead 3절 끝난 팀원 닫기 절차). 문맥 줄이기: 요약을 넘겨 새 서브에이전트를 띄운다.'

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function followUp(action: Slash, e: Request) {
  const lines = [action === 'clear' && e.handoff ? `인계 파일 ${e.handoff} 를 읽고 이어간다.` : '', e.then ?? '']
  return lines.filter(Boolean).join('\n')
}

async function refuse($: EngineInterface, e: Request, agentId?: string) {
  if (!actions.includes(e.action as Action)) return `action 은 ${actions.join(', ')} 중 하나다.`
  if (agentId) return '이 도구는 리드 메인 대화 전용이다. 서브에이전트는 어떤 대상도 제어할 수 없다.'
  const target = e.target ?? 'self'
  if (e.action === 'whoami') return
  if (e.action === 'rebind' && (!target.startsWith('claude:') || !e.lead)) return 'rebind 는 target claude:<이름> 과 lead(새 리드 세션 ID)가 필요하다.'
  if (target === 'self' && e.action === 'exit' && !e.handoff) return 'exit 는 handoff 가 필요하다. 인계 파일을 먼저 쓰고 그 경로를 넘긴다.'
  if (target.startsWith('subagent:')) return subagentAlternative
  if (target !== 'self' && !/^(?:claude|codex|agy):./.test(target))
    return `지원하지 않는 대상: ${target}. self, claude:<이름>, codex:<tmux 세션>, agy:<tmux 세션> 중 하나다.`
  if (target.startsWith('agy:') && e.action === 'compact') return 'agy 는 compact 가 없다. clear 를 쓰거나 handoff 뒤 새 세션으로 넘긴다.'
  if (target.startsWith('codex:') && e.action === 'compact' && e.instructions) return 'Codex compact 는 지시문을 받지 않는다. instructions 를 빼고 then 에 싣는다.'
  if (e.handoff && !(await $.fs.exists(e.handoff))) return `인계 파일이 없다: ${e.handoff}. 먼저 쓴 뒤 다시 호출한다.`
}

function slash($: EngineInterface, action: Slash, e: Request) {
  return $.command.run({ command: action, args: action === 'compact' ? (e.instructions ?? '') : '' })
}

// 리드 자기 세션: 실패와 뒤따름 문장은 리드 자신의 다음 턴 prompt 로 넣는다.
async function run($: EngineInterface, action: Slash, e: Request) {
  try {
    await slash($, action, e)
  } catch (error) {
    await $.prompt.submit({ text: `[tfx_control] /${action} 실패: ${errorText(error)}. 사용자에게 /${action} 직접 입력을 요청한다.` })
    return
  }
  const text = followUp(action, e)
  if (action !== 'exit' && text) await $.prompt.submit({ text })
}

async function reply($: EngineInterface, from: string, text: string) {
  const sent = await $.session.send({ to: { sessionId: from }, text })
  if (!sent.isDelivered) await $.ui.toast(`${text} (리드에게 전달 실패: ${sent.reason})`)
}

// 받는 쪽 세션: 남의 문장이 사용자 프롬프트로 올라가지 않게 prompt.submit 은 쓰지 않는다.
// 뒤따름 문장은 출처 머리말을 붙인 자기 세션 피어 메시지로 넣고, 결과는 보낸 리드에게 알린다.
async function runReceived($: EngineInterface, action: Slash, e: Delivered & { from: string }) {
  if (action === 'exit') {
    if (!e.handoff) return reply($, e.from, '[tfx_control] /exit 거부: handoff 가 없다. 인계 파일을 쓰고 경로를 넘긴다.')
    await reply($, e.from, `[tfx_control] /exit 실행: 인계 파일 ${e.handoff}`)
  }
  try {
    await slash($, action, e)
  } catch (error) {
    return reply($, e.from, `[tfx_control] /${action} 실패: ${errorText(error)}.`)
  }
  if (action === 'exit') return
  const text = followUp(action, e)
  if (text) {
    const message = `[tfx-control from ${e.leadName ?? e.from}] ${text}`
    let reason: string | undefined
    try {
      const result = await $.process.run(['tfx-peer', 'self', '--session', await $.session.id(), '--message', message], { stdin: '', timeoutMs: 10_000 })
      let status: string | undefined
      try {
        status = JSON.parse(result.stdout).status
      } catch {
        // 실패하면 stdout 이 비고 이유는 stderr 에 있다.
      }
      if (result.exitCode !== 0 || status !== 'written') reason = result.stderr.trim() || status || `exit ${result.exitCode}`
    } catch (error) {
      reason = errorText(error)
    }
    if (reason) return reply($, e.from, `[tfx_control] /${action} 완료, 뒤따름 문장 전달 실패: ${reason.slice(0, 200)}`)
  }
  await reply($, e.from, `[tfx_control] /${action} 완료`)
}

async function tfxLive($: EngineInterface, argv: string[]) {
  const process = await $.process.run(['tfx-live', ...argv], { stdin: '', timeoutMs: 120_000, env: { CLAUDECODE: '1' } })
  if (process.exitCode !== 0) throw new Error((process.stderr.trim() || process.stdout.trim() || `exit ${process.exitCode}`).slice(0, 500))
  return process.stdout
}

async function controlTmux($: EngineInterface, cli: string, session: string, action: Slash, e: Request) {
  // Claude 가 로컬 Claude 에 ask 하면 tfx-live 가 SendMessage 를 쓰라며 거부하므로 tmux 입력을 명시한다.
  const ask = (prompt: string) => ['ask', '--cli', cli, '--session', session, '--prompt', prompt, '--no-wait', ...(cli === 'claude' ? ['--via-tmux'] : [])]
  if (action === 'exit') await tfxLive($, ['stop', '--cli', cli, '--session', session])
  else if (action === 'compact')
    await tfxLive($, ['compact', '--cli', cli, '--session', session, ...(cli === 'claude' ? ['--if-busy', 'wait'] : []), ...(e.instructions ? ['--instructions', e.instructions] : []), ...(e.then ? ['--then', e.then] : []), '--no-wait'])
  else {
    await tfxLive($, ask(cli === 'codex' ? '/new' : '/clear'))
    const text = followUp(action, e)
    // Codex 기본 queue 는 /new 뒤에도 옛 thread 로 보내므로 tmux 로 새 대화에 넣는다.
    if (text) await tfxLive($, [...ask(text), ...(cli === 'codex' ? ['--transport', 'tmux'] : [])])
  }
  return { result: `${cli}:${session} 에 tmux 로 ${action} 를 보냈다.` }
}

async function controlClaude($: EngineInterface, name: string, action: Exclude<Action, 'whoami'>, e: Request, leadName: string): Promise<ToolCallResult> {
  // 묶기는 받는 쪽 mod 의 저장값이라 rebind 는 tmux 안이어도 피어 경로로 보낸다.
  if (action !== 'rebind') {
    const sessions: { session: string; name?: string }[] = JSON.parse(await tfxLive($, ['list-sessions', '--cli', 'claude'])).sessions ?? []
    const tmux = sessions.find(entry => entry.name === name || entry.session === name)
    if (tmux) return controlTmux($, 'claude', tmux.session, action, e)
  }
  const body: Delivered = { action, instructions: e.instructions, then: e.then, handoff: e.handoff, lead: e.lead, from: await $.session.id(), leadName }
  const sent = await $.session.send({ to: name, text: `${controlMarker} ${JSON.stringify(body)}` })
  if (!sent.isDelivered) return { deny: `claude:${name} 전송 실패: ${sent.reason}` }
  return { result: `claude:${name} 에 표식 피어 메시지로 ${action} 를 보냈다. 전송만 확인, 실행 미확인(받는 쪽에서 "[tfx_control] /${action} 완료" 알림이 오면 실행됨). 알림이 오지 않으면 받는 쪽에 triflux mod 가 없다. 거부 알림이 오면 이 리드가 그 세션을 띄우지 않았다.` }
}

// 받는 쪽: 자기를 띄운 리드에게서 온 표식 메시지만 실행한다. 거부도 보낸 쪽에 알린다.
async function receive($: EngineInterface, bound: Holder, body: Delivered & { from: string }) {
  const mark = (await sessionMark($, boundKey, bound)) as Bound | undefined
  if (!mark) return () => reply($, body.from, '[tfx_control] 거부: 이 세션은 리드가 띄운 세션이 아니다(TFX_LEAD_SESSION_ID 없음). tmux 안이면 tfx-live 로 제어한다.')
  if (body.from !== mark.lead) return () => reply($, body.from, '[tfx_control] 거부: 이 세션을 띄운 리드가 아니다.')
  if (body.action === 'rebind') {
    const lead = body.lead
    if (!lead) return () => reply($, body.from, '[tfx_control] rebind 거부: lead 가 없다.')
    await $.store.set(boundKey + (await $.session.id()), { lead } satisfies Bound)
    return () => reply($, body.from, `[tfx_control] rebind 완료: 새 리드 ${lead}`)
  }
  const action = body.action as Slash
  return () => runReceived($, action, body)
}

export function registerControl(on: On, lead: Holder) {
  const bound: Holder = {}
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    await $.tool.register({ name: 'tfx_control', description, inputSchema, isDeferred: false })
    const leadId = await $.env.get('TFX_LEAD_SESSION_ID')
    if (leadId) {
      const sessionId = await $.session.id()
      await $.store.set(boundKey + sessionId, { lead: leadId } satisfies Bound)
      bound.sessionId = sessionId
      // 이 세션이 띄우는 하위 프로세스가 같은 리드에 묶이지 않게 지운다.
      await $.env.set('TFX_LEAD_SESSION_ID', undefined)
    }
    return next(e)
  })
  on('session.end', { reason: ['prompt_input_exit', 'resume', 'logout', 'other'] }, async ($, e, next) => {
    await $.store.delete(boundKey + e.sessionId)
    if (bound.sessionId && bound.sessionId !== e.sessionId) await $.store.delete(boundKey + bound.sessionId)
    bound.sessionId = undefined
    return next(e)
  })
  on('tool.call', { tool: controlTool }, async ($, e) => {
    const mark = await leadOf($, lead)
    if (!mark) return { deny: '이 세션은 리드가 아니다. /tfx-lead <역할> 을 먼저 실행한다.' }
    const request = e as Request
    const reason = await refuse($, request, e.agentId)
    if (reason) return { deny: reason }
    const action = request.action as Action
    const name = leadSessionName(mark.role, Date.parse(mark.since))
    if (action === 'whoami') return { result: JSON.stringify({ sessionId: await $.session.id(), name }) }
    const target = request.target ?? 'self'
    const cli = target.split(':', 1)[0] ?? target
    const targetName = target.slice(cli.length + 1)
    if (cli === 'self') {
      const own = action as Slash
      // 이 훅이 도는 동안의 $.command.run 은 거부되므로 마지막 await 뒤에 타이머를 건다.
      $.clock.after(0, () => run($, own, request)
        .catch(error => $.ui.toast(`[tfx_control] /${own} 결과 알림 실패: ${errorText(error)}`)))
      return { result: `/${own} 예약: 이 턴이 끝나면 실행한다. 응답을 짧게 마친다.` }
    }
    try {
      if (cli !== 'claude') return await controlTmux($, cli, targetName, action as Slash, request)
      return await controlClaude($, targetName, action, request, name)
    } catch (error) {
      const hint = cli === 'claude' ? '' : ` ${cli} 는 tmux 로 띄운 세션만 제어한다.`
      return { deny: `${cli}:${targetName} ${action} 실패: ${errorText(error)}.${hint}` }
    }
  })
  on('session.receive', async ($, e, next) => {
    // 모델이 SendMessage 로 쓴 메시지에는 origin.plugin 이 없다. 표식을 흉내 낸 모델 메시지는 여기서 걸러진다.
    if (e.origin.kind !== 'peer' || e.origin.plugin !== 'triflux-mods' || e.agentId) return next(e)
    // 봉투 형식은 실측 전이라 trim 한 본문 전체가 표식 한 줄일 때만 맞춘다. 인용한 표식 줄은 실행하지 않는다.
    const json = /^\[tfx-control\] (\{.*\})$/.exec(e.text.trim())?.[1]
    if (!json) return next(e)
    let body: Delivered
    try {
      body = JSON.parse(json)
    } catch {
      return next(e)
    }
    const { from, action } = body
    if (!from || !(action === 'rebind' || slashes.includes(action as Slash))) return next(e)
    const task = await receive($, bound, { ...body, from })
    // 이 훅이 도는 동안의 $.command.run 은 거부되므로 마지막 await 뒤에 타이머를 건다.
    $.clock.after(0, () => task().catch(error => $.ui.toast(`[tfx_control] ${action} 처리 실패: ${errorText(error)}`)))
    return { consumed: 'tfx-control' }
  })
}
