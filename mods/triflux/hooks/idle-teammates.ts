import type { AgentInfo, EngineInterface, On, Timer } from 'claude-code'

import { type Holder, leadOf } from './lead-role.ts'
import { notifyLead } from './memory-pressure.ts'

// 팀원이 쉬기 시작한 때를 알리는 이벤트가 터미널 pane 팀원에는 없어 명단을 2분마다 잰다.
export const sweepMs = 120_000
export const noticeMs = 600_000

type Idle = { since: number; noticedAt?: number; isShutdownSent?: boolean }
export type Sweeper = { timer?: Timer; isSweeping?: boolean; idle: Map<string, Idle> }

// 터미널 pane 팀원은 id 가 팀 주소(--agent-id 값)이고, pane 이 닫혀도 명단에 idle 로 남는다. 그래서 살아 있는 pane 의 주소를 모은다.
async function paneAgentIds($: EngineInterface) {
  if (!(await $.env.get('TMUX'))) return
  try {
    const result = await $.process.run(['tmux', 'list-panes', '-a', '-F', '#{pane_start_command}'], { stdin: '', timeoutMs: 10_000 })
    if (result.exitCode !== 0) return
    const ids = new Set<string>()
    for (const line of result.stdout.split('\n')) {
      const id = /--agent-id\s+['"]?([^\s'"]+)/.exec(line)?.[1]
      if (id) ids.add(id)
    }
    return ids
  } catch {
    return
  }
}

function isOpen(agent: AgentInfo, panes: Set<string> | undefined) {
  if (agent.status !== 'idle' || !agent.name || agent.parentId) return false
  return !(panes && agent.id === agent.teammateId && !panes.has(agent.id))
}

async function shutdown($: EngineInterface, agent: AgentInfo) {
  try {
    const result = await $.tool.call({ tool: 'SendMessage', to: agent.name, message: { type: 'shutdown_request',
      reason: '[tfx-lead] 결과를 보낸 뒤 20분째 쉬고 있다. 남은 일이 없으면 승인하고, 리드에게서 받을 일이 남았으면 그 이유로 거절한다.' } })
    if (result.deny || result.isError) return `${agent.name}: ${result.deny ?? result.text ?? '오류'}`
  } catch (error) {
    return `${agent.name}: ${error instanceof Error ? error.message : String(error)}`
  }
}

export async function sweep($: EngineInterface, lead: Holder, sweeper: Sweeper) {
  const { idle } = sweeper
  // 리드 표지가 없는 세션의 팀원은 사용자가 직접 다루므로 건드리지 않는다.
  if (!(await leadOf($, lead))) {
    idle.clear()
    return
  }
  const now = await $.clock.now()
  const panes = await paneAgentIds($)
  const open = (await $.agent.list()).filter(agent => isOpen(agent, panes))
  for (const id of idle.keys()) if (!open.some(agent => agent.id === id)) idle.delete(id)
  for (const agent of open) if (!idle.has(agent.id)) idle.set(agent.id, { since: now })
  const overdue = open.filter(agent => now - idle.get(agent.id)!.since >= noticeMs)
  if (overdue.some(agent => idle.get(agent.id)!.noticedAt === undefined)) {
    const names = overdue.map(agent => `${agent.name} ${Math.floor((now - idle.get(agent.id)!.since) / 60_000)}분`)
    for (const agent of overdue) idle.get(agent.id)!.noticedAt ??= now
    await notifyLead($, `[tfx-lead] 결과를 보내고 쉬는 팀원 ${overdue.length}개가 열려 있다: ${names.join(', ')}. 결과를 받았으면 tfx-lead 3절 "끝난 팀원 닫기"대로 닫는다. 10분 더 열려 있으면 mod 가 팀원에게 종료를 요청한다.`, () => true)
  }
  // 알린 뒤 10분이 더 지난 팀원에게만 종료를 요청한다. 거절할 수 있게 강제 종료는 하지 않는다.
  const failures: string[] = []
  for (const agent of overdue) {
    const state = idle.get(agent.id)!
    if (!agent.teammateId || state.isShutdownSent || now - state.noticedAt! < noticeMs) continue
    state.isShutdownSent = true
    const failure = await shutdown($, agent)
    if (failure) failures.push(failure)
  }
  if (failures.length) await notifyLead($, `[tfx-lead] 팀원 종료 요청 실패: ${failures.join('; ').slice(0, 500)}. 직접 닫는다.`, () => true)
}

export function registerIdleTeammates(on: On, lead: Holder) {
  const sweeper: Sweeper = { idle: new Map() }
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    sweeper.timer?.cancel()
    sweeper.idle.clear()
    sweeper.timer = $.clock.every(sweepMs, async () => {
      if (sweeper.isSweeping) return
      sweeper.isSweeping = true
      try {
        await sweep($, lead, sweeper)
      } catch {
        // 한 번 잰 것이 실패해도 다음 주기에 다시 잰다.
      } finally {
        sweeper.isSweeping = false
      }
    })
    return next(e)
  })
}
