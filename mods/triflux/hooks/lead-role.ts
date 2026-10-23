import type { EngineInterface, On } from 'claude-code'

import { enablePressure, type Monitor } from './memory-pressure.ts'

const datePrefix = /^\d{1,2}\.\d{1,2} /

export function leadSessionName(role: string, now: number) {
  if (datePrefix.test(role)) return role
  const date = new Date(now)
  return `${date.getMonth() + 1}.${date.getDate()} ${role}`
}

// 이 프로세스에서 표지를 남긴 세션 ID. /clear 뒤 표지를 새 ID 로 옮길 때 쓴다.
export type Holder = { sessionId?: string }
export type LeadMark = { role: string; since: string }

const leadKey = (sessionId: string) => 'tfx.lead.' + sessionId

// 세션 ID 로 묶인 표지를 읽는다. /clear 는 같은 프로세스에서 세션 ID 만 바꾸므로 옛 ID 의 표지를 새 ID 로 옮긴다.
export async function sessionMark($: EngineInterface, prefix: string, holder: Holder) {
  const sessionId = await $.session.id()
  const mark = await $.store.get(prefix + sessionId)
  if (mark || !holder.sessionId || holder.sessionId === sessionId) return mark
  const moved = await $.store.get(prefix + holder.sessionId)
  if (!moved) return
  await $.store.set(prefix + sessionId, moved)
  await $.store.delete(prefix + holder.sessionId)
  holder.sessionId = sessionId
  return moved
}

export async function leadOf($: EngineInterface, lead: Holder) {
  return (await sessionMark($, 'tfx.lead.', lead)) as LeadMark | undefined
}

export function registerLeadRole(on: On, monitor: Monitor, lead: Holder) {
  for (const isInteractive of [true, false]) {
    on('session.start', { isInteractive }, async ($, e, next) => {
      await $.command.register({ name: 'tfx-lead', description: '이 세션에 역할 리드를 맡긴다: <역할>', argumentHint: '<역할>' })
      return next(e)
    })
  }
  // resume 한 세션은 /tfx-lead 를 다시 실행해야 리드가 된다. /clear 는 표지를 옮기므로 지우지 않는다.
  on('session.end', { reason: ['prompt_input_exit', 'resume', 'logout', 'other'] }, async ($, e, next) => {
    await $.store.delete(leadKey(e.sessionId))
    if (lead.sessionId && lead.sessionId !== e.sessionId) await $.store.delete(leadKey(lead.sessionId))
    lead.sessionId = undefined
    return next(e)
  })
  on('command.run', { command: 'tfx-lead' }, async ($, e) => {
    const role = e.args.trim()
    if (!role) return { text: '사용법: /tfx-lead <역할>' }
    const now = await $.clock.now()
    const name = leadSessionName(role, now)
    const sessionId = await $.session.id()
    await $.store.set(leadKey(sessionId), { role, since: new Date(now).toISOString() } satisfies LeadMark)
    lead.sessionId = sessionId
    const pressure = await enablePressure($, monitor)
    // 호스트는 이 훅이 도는 동안의 $.command.run 을 타이머에서 부른 것까지 거부한다.
    // 그래서 마지막 await 뒤에 타이머를 걸어 훅이 끝난 다음에 rename 이 돌게 한다.
    $.clock.after(0, () => $.command.run({ command: 'rename', args: name })
      .catch(() => $.ui.toast(`이름 변경 실패: /rename ${name} 을 직접 실행`)))
    return {
      text: `이름 변경 요청: ${name}. ${pressure}`,
      context: [`이 세션의 리드 역할은 ${role.replace(datePrefix, '')}이다. tfx-lead 스킬을 로드해 그 절차를 따른다.`],
    }
  })
}
