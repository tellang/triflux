import type { EngineInterface, On } from 'claude-code'

export const controlTool = 'mcp__triflux-mods__tfx_control'

const actions = ['compact', 'clear', 'exit'] as const
type Action = (typeof actions)[number]
type Request = { target?: string; action?: string; instructions?: string; then?: string; handoff?: string }

const description = [
  '리드 세션 자신에게 /compact, /clear, /exit 를 건다. 모델은 내장 슬래시 명령을 직접 실행하지 못하므로 이 도구가 대신 실행한다.',
  '호출하면 예약만 하고, 실제 실행은 이 턴이 끝난 뒤다. 그러니 호출한 다음 응답을 짧게 마친다.',
  'compact: instructions 는 요약 지시문, then 은 압축 뒤 넣을 다음 프롬프트.',
  'clear: 전에 handoff 파일을 써 두고 경로를 넘기면 clear 뒤 그 파일을 읽으라는 줄과 then 을 차례로 넣는다.',
  'exit: handoff 파일 경로가 필수다. 사용자가 끝내라고 했거나 승계 세션이 인계 파일을 받기로 한 경우에만 쓴다.',
  '실행 뒤 실패는 다음 턴 prompt 로 알린다.',
].join(' ')

const inputSchema = {
  type: 'object',
  properties: {
    target: { type: 'string', description: '제어할 세션. 지금은 self 만 지원한다.', default: 'self' },
    action: { type: 'string', enum: actions },
    instructions: { type: 'string', description: 'compact 지시문' },
    then: { type: 'string', description: 'compact 나 clear 뒤 넣을 다음 프롬프트' },
    handoff: { type: 'string', description: 'clear, exit 전에 써 둔 인계 파일 경로. exit 는 필수' },
  },
  required: ['action'],
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function refuse($: EngineInterface, e: Request, agentId?: string) {
  if (agentId) return '서브에이전트는 리드 세션을 제어할 수 없다.'
  if ((e.target ?? 'self') !== 'self') return `지원하지 않는 대상: ${e.target}. 지금은 self 만 된다.`
  if (!actions.includes(e.action as Action)) return `action 은 ${actions.join(', ')} 중 하나다.`
  if (e.action === 'exit' && !e.handoff) return 'exit 는 handoff 가 필요하다. 인계 파일을 먼저 쓰고 그 경로를 넘긴다.'
  if (e.handoff && !(await $.fs.exists(e.handoff))) return `인계 파일이 없다: ${e.handoff}. 먼저 쓴 뒤 다시 호출한다.`
}

async function run($: EngineInterface, action: Action, e: Request) {
  try {
    await $.command.run({ command: action, args: action === 'compact' ? (e.instructions ?? '') : '' })
  } catch (error) {
    await $.prompt.submit({ text: `[tfx_control] /${action} 실패: ${errorText(error)}. 사용자에게 /${action} 직접 입력을 요청한다.` })
    return
  }
  const lines = [action === 'clear' && e.handoff ? `인계 파일 ${e.handoff} 를 읽고 이어간다.` : '', e.then ?? '']
  const text = lines.filter(Boolean).join('\n')
  if (action !== 'exit' && text) await $.prompt.submit({ text })
}

export function registerControl(on: On) {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    await $.tool.register({ name: 'tfx_control', description, inputSchema, isDeferred: false })
    return next(e)
  })
  on('tool.call', { tool: controlTool }, async ($, e) => {
    const request = e as Request
    const reason = await refuse($, request, e.agentId)
    if (reason) return { deny: reason }
    const action = request.action as Action
    // 이 훅이 도는 동안의 $.command.run 은 거부되므로 마지막 await 뒤에 타이머를 건다.
    $.clock.after(0, () => run($, action, request))
    return { result: `/${action} 예약: 이 턴이 끝나면 실행한다. 응답을 짧게 마친다.` }
  })
}
