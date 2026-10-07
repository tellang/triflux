import { expect, test } from 'claude-code/testing'

test('서브에이전트 effort 를 역할표 값으로 바꾸고, effort 없는 모델은 그대로 둔다', async ($, on) => {
  const seen: unknown[] = []
  on('agent.spawn', async () => ({ agentId: 'a1', model: 'claude-sonnet-5-5' }) as never)
  on('turn.step', async function* (_, e) {
    seen.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })

  await $.agent.spawn({ prompt: 'x', subagentType: 'Explore' } as Parameters<typeof $.agent.spawn>[0])
  const step = { turnId: 't', index: 0, model: 'm', messageCount: 1, agentId: 'a1' }
  const runStep = async (input: Parameters<typeof $.turn.step>[0]) => {
    for await (const _ of $.turn.step(input));
  }
  await runStep({ ...step, effort: 'xhigh' })
  await runStep(step)
  await runStep({ ...step, agentId: 'other', effort: 'xhigh' })

  expect(seen).toEqual(['low', undefined, 'xhigh'])
})
