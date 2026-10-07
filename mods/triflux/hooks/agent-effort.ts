import type { On } from 'claude-code'

type Effort = 'low' | 'medium' | 'high'

// 서브에이전트는 부모 effort 를 물려받지 않는다(Sonnet 기본 xhigh). 탐색은 낮게, 판정은 높게.
const EFFORT_BY_AGENT: Record<string, Effort> = {
  Explore: 'low',
  'oh-my-claudecode:explore': 'low',
  'general-purpose': 'medium',
  'oh-my-claudecode:executor': 'medium',
  'oh-my-claudecode:test-engineer': 'medium',
  'oh-my-claudecode:writer': 'medium',
  Plan: 'high',
  'oh-my-claudecode:architect': 'high',
  'oh-my-claudecode:analyst': 'high',
  'oh-my-claudecode:critic': 'high',
  'oh-my-claudecode:planner': 'high',
  'oh-my-claudecode:code-reviewer': 'high',
  'oh-my-claudecode:security-reviewer': 'high',
  'oh-my-claudecode:verifier': 'high',
  'oh-my-claudecode:debugger': 'high',
  'oh-my-claudecode:tracer': 'high',
}

export function registerAgentEffort(on: On) {
  const explicitCalls = new Set<string>()
  const effortByAgentId = new Map<string, Effort>()

  on('tool.call', { tool: 'Agent' }, ($, e, next) => {
    if (e.effort) explicitCalls.add(e.tool_use_id)
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    const effort = EFFORT_BY_AGENT[e.subagentType]
    // 호출자가 Agent 도구에 effort 를 직접 적었으면 그 값을 따른다.
    if (spawned.agentId && effort && !e.fork && !explicitCalls.has(e.tool_use_id))
      effortByAgentId.set(spawned.agentId, effort)
    explicitCalls.delete(e.tool_use_id)
    return spawned
  })

  on('turn.step', async function* ($, e, next) {
    const effort = e.agentId ? effortByAgentId.get(e.agentId) : undefined
    // effort 가 없는 모델(Haiku 등)은 건드리지 않는다.
    return yield* next(effort && e.effort !== undefined ? { ...e, effort } : e)
  })
}
