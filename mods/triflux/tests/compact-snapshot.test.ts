import type { On, SessionCompactInput, SessionMessage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { snapshotLimit, workersPath } from '../hooks/compact-snapshot.ts'

const table = '| 이름 | CLI |\n|---|---|\n| reviewer | Claude sonnet |'

function fixture(on: On, workers?: string) {
  mock.store(on, { 'tfx.lead.lead-1': { role: '개발리드', since: new Date(2026, 9, 23, 12).toISOString() } })
  on('session.id', () => ({ value: 'lead-1' }))
  on('session.root', () => ({ value: '/work' }))
  on('fs.read', (_, e) => {
    if (e.path !== `/work/${workersPath}` || workers === undefined) throw new Error('ENOENT')
    return { value: workers }
  })
  const seen: (string | undefined)[] = []
  on('session.compact', (_, e) => { seen.push(e.instructions); return { messages: [...e.messages] } })
  return seen
}

// 테스트 키트의 compact 는 대화를 싣지 않으므로 /compact 처럼 대화 한 줄을 실어 보낸다.
const transcript: SessionMessage[] = [{ role: 'user', text: '작업', toolUses: [] }]
const compact = ($: { session: { compact: (e: SessionCompactInput) => Promise<unknown> } }, instructions?: string) =>
  $.session.compact({ trigger: 'manual', messages: transcript, instructions })

test('리드 세션이면 역할, 이름, 등록 워커 표를 담은 리드 블록이 붙는다', async ($, on) => {
  const seen = fixture(on, `# 워커\n\n${table}\n`)
  await compact($)
  expect(seen[0]).toContain('리드 역할: 개발리드, 세션 이름: 10.23 개발리드')
  expect(seen[0]).toContain(table)
  expect(seen[0]).toContain('열린 PR')
})

test('사용자 instructions 는 앞에 그대로 남고 블록은 뒤에 붙는다', async ($, on) => {
  const seen = fixture(on)
  await compact($, '마이그레이션 계획을 남겨라')
  expect(seen[0]?.startsWith('마이그레이션 계획을 남겨라\n\n[tfx 압축 스냅샷]')).toBe(true)
})

test('상한을 넘으면 낮은 순위부터 빠진다', async ($, on) => {
  // 표까지 넣으면 상한 바로 밑이고 PR 항목을 더하면 넘는 크기다.
  const big = `| 이름 | CLI |\n${'| worker | Claude opus 긴 설명 |\n'.repeat(61)}`
  const seen = fixture(on, big)
  await compact($)
  const block = seen[0] ?? ''
  expect(block.length).toBeLessThanOrEqual(snapshotLimit)
  expect(block).toContain('리드 역할: 개발리드')
  expect(block).toContain('| worker | Claude opus 긴 설명 |')
  expect(block).not.toContain('열린 PR')
  expect(block).not.toContain('사용자 결정')
})
