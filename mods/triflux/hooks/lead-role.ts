import type { EngineInterface, On } from 'claude-code'

import { enablePressure, type Monitor } from './memory-pressure.ts'

const datePrefix = /^\d{1,2}\.\d{1,2} /

export function leadSessionName(role: string, now: number) {
  if (datePrefix.test(role)) return role
  const date = new Date(now)
  return `${date.getMonth() + 1}.${date.getDate()} ${role}`
}

// 이 프로세스에서 표지를 남긴 세션 ID. /clear 뒤 표지를 새 ID 로 옮길 때 쓴다.
export type Holder = { sessionId?: string; monitor?: Monitor }
export type LeadMark = { role: string; since: string; kind?: 'lead' | 'communication' }

const leadKey = (sessionId: string) => 'tfx.lead.' + sessionId

function parseLeadArgs(raw: string): { role: string; kind: 'lead' | 'communication' } {
  const trimmed = raw.trim()
  const match = /^--role(?:\s+|=)communication(?:\s+(.+))?$/u.exec(trimmed)
  if (match) return { role: (match[1] ?? '').trim(), kind: 'communication' }
  return { role: trimmed, kind: 'lead' }
}

async function liveTmuxSessionForPane($: EngineInterface, paneId: string): Promise<string | null | undefined> {
  if (!(await $.env.get('TMUX'))) return undefined
  try {
    const res = await $.process.run(['tmux', 'display-message', '-p', '-t', paneId, '#{session_name}'], {
      stdin: '',
      timeoutMs: 2_000,
    })
    if (res.exitCode !== 0) return null
    return res.stdout.trim() || null
  } catch {
    return null
  }
}

async function adoptPaneLeadMarker($: EngineInterface, monitor: Monitor, lead: Holder) {
  try {
    const paneId = await $.env.get('TMUX_PANE')
    if (!paneId) return
    const sessionId = await $.session.id()
    if (await $.store.get(leadKey(sessionId))) return
    const xdgState = await $.env.get('XDG_STATE_HOME')
    const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
    const stateBase = xdgState || (home ? `${home}/.local/state` : '')
    if (!stateBase) return
    const dir = `${stateBase}/triflux/lead-roles`
    const entries = await $.fs.list(dir)
    let liveSession: string | null | undefined
    for (const entry of entries) {
      if (entry.type !== 'file' || !entry.name.endsWith('.json')) continue
      try {
        const raw = JSON.parse(await $.fs.read(`${dir}/${entry.name}`)) as {
          session?: string | null
          paneId?: string | null
          cli?: string | null
          sessionRole?: string | null
          role?: string | null
          since?: string | null
        }
        if (raw?.paneId !== paneId || raw?.cli !== 'claude') continue
        if (raw.sessionRole !== 'lead' && raw.sessionRole !== 'communication') continue
        if (liveSession === undefined) liveSession = await liveTmuxSessionForPane($, paneId)
        if (liveSession === null || (liveSession !== undefined && raw.session && liveSession !== raw.session)) continue
        const role = typeof raw.role === 'string' && raw.role.trim() ? raw.role.trim() : raw.sessionRole
        const since = typeof raw.since === 'string' && raw.since ? raw.since : new Date(await $.clock.now()).toISOString()
        const kind = raw.sessionRole === 'communication' ? 'communication' : 'lead'
        await $.store.set(leadKey(sessionId), { role, since, kind } satisfies LeadMark)
        lead.sessionId = sessionId
        await enablePressure($, monitor)
        return
      } catch {}
    }
  } catch {}
}

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
  const existing = (await sessionMark($, 'tfx.lead.', lead)) as LeadMark | undefined
  if (existing) return existing
  if (lead.monitor?.interactive) {
    await adoptPaneLeadMarker($, lead.monitor, lead)
    return (await sessionMark($, 'tfx.lead.', lead)) as LeadMark | undefined
  }
  return undefined
}

export function registerLeadRole(on: On, monitor: Monitor, lead: Holder) {
  lead.monitor = monitor
  for (const isInteractive of [true, false]) {
    on('session.start', { isInteractive }, async ($, e, next) => {
      await $.command.register({ name: 'tfx-lead', description: '이 세션에 역할 리드를 맡긴다: <역할>', argumentHint: '<역할>' })
      if (isInteractive) await adoptPaneLeadMarker($, monitor, lead)
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
    const { role, kind } = parseLeadArgs(e.args)
    if (!role) return { text: '사용법: /tfx-lead <역할>' }
    const now = await $.clock.now()
    const name = leadSessionName(role, now)
    const sessionId = await $.session.id()
    await $.store.set(leadKey(sessionId), { role, since: new Date(now).toISOString(), kind } satisfies LeadMark)
    lead.sessionId = sessionId
    const pressure = await enablePressure($, monitor)
    // 호스트는 이 훅이 도는 동안의 $.command.run 을 타이머에서 호출한 것까지 거부한다.
    // 그래서 마지막 await 뒤에 타이머를 걸어 훅이 끝난 다음에 rename 이 돌게 한다.
    $.clock.after(0, () => $.command.run({ command: 'rename', args: name })
      .catch(() => $.ui.toast(`이름 변경 실패: /rename ${name} 을 직접 실행`)))
    const cleanRole = role.replace(datePrefix, '')
    const contextText =
      kind === 'communication'
        ? `이 세션은 ${cleanRole} 소통 세션을 맡는다. tfx-lead 스킬을 로드해 "소통 세션" 절을 따른다.`
        : `이 세션의 리드 역할은 ${cleanRole}이다. tfx-lead 스킬을 로드해 그 절차를 따른다.`
    return {
      text: `이름 변경 요청: ${name}. ${pressure}`,
      context: [contextText],
    }
  })
}
