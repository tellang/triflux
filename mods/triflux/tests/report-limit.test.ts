import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const leadMark = { 'tfx.lead.lead-1': { role: '개발리드', since: '2026-10-23T00:00:00.000Z' } }

function fixture(on: On) {
  mock.store(on, leadMark)
  on('session.id', () => ({ value: 'lead-1' }))
  const toasts: string[] = []
  on('ui.toast', (_, e) => { toasts.push(e.text); return { value: undefined } })
  return { toasts, session: mock.session(on) }
}

test('상한을 넘는 서브에이전트 결과는 앞 800자와 파일 경로만 남기고 짧은 하네스 블록은 둔다', async ($, on) => {
  const f = fixture(on)
  const report = `요약 줄\n${'가'.repeat(4500)}\n결과: /work/.omc/briefs/a.result.md 와 docs/adr/0046-x.md 참조`
  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: report }, { type: 'text', text: 'agentId: a1' }] }] },
    door: 'tool-result', origin: { kind: 'tool', tool: 'Agent' }, uuid: 'u1',
  })
  const [row] = f.session.appended()
  const blocks = (row?.message.content[0] as { content: { text: string }[] }).content
  expect(blocks).toHaveLength(2)
  expect(blocks[0]?.text.startsWith(report.slice(0, 800))).toBe(true)
  expect(blocks[0]?.text).toContain('- /work/.omc/briefs/a.result.md\n- docs/adr/0046-x.md')
  expect(blocks[0]?.text).toContain(`원문 ${report.length + 'agentId: a1'.length + 1}자, 결과 파일 참조`)
  expect(blocks[0]!.text.length).toBeLessThan(1000)
  expect(blocks[1]?.text).toBe('agentId: a1')
  expect(f.toasts).toEqual([])
})

test('상한을 넘어도 파일 경로가 없는 피어 메시지는 자르지 않고 경고만 띄운다', async ($, on) => {
  const f = fixture(on)
  on('session.receive', (_, e) => ({ text: e.text }))
  const text = '나'.repeat(5000)
  const result = await $.session.receive({ origin: { kind: 'peer' }, text })
  expect(result.text).toBe(text)
  expect(f.toasts).toHaveLength(1)
  expect(f.toasts[0]).toContain('피어 메시지 5000자')
})
