import type { EngineInterface, On } from 'claude-code'

import { type Holder, leadOf, leadSessionName } from './lead-role.ts'

// 압축 지시에 붙이는 블록의 상한. 요약 예산을 블록이 다 쓰지 않게 한다.
export const snapshotLimit = 2000
export const workersPath = '.omc/lead/workers.md'

const header = '[tfx 압축 스냅샷] 요약에 다음 항목을 반드시 남겨라. 압축 뒤 첫 턴에서 다시 읽지 않고 이어가기 위해서다.'

const commonItems = [
  '- 현재 작업 목표와 범위',
  '- 결과 파일과 지시서 경로',
  '- 남은 일과 다음 단계',
]

async function workersTable($: EngineInterface) {
  try {
    const text = await $.fs.read(`${await $.session.root()}/${workersPath}`)
    const rows = text.split('\n').filter(line => line.trimStart().startsWith('|'))
    if (rows.length) return `- 등록 워커(${workersPath} 의 표 그대로):\n${rows.join('\n')}`
  } catch {
    // 파일이 없으면 대화에서 뽑으라는 지시로 대신한다.
  }
  return '- 등록 워커: 이름, CLI, 위치, 역할, 지시서 경로'
}

// 높은 순위부터 놓는다. 상한을 넘으면 뒤에서부터 뺀다.
async function leadItems($: EngineInterface, role: string, since: string) {
  return [
    `- 리드 역할: ${role}, 세션 이름: ${leadSessionName(role, Date.parse(since))}`,
    '- 인계 파일과 지시서 경로',
    await workersTable($),
    '- 열린 PR 번호와 리뷰 상태(리뷰어, 판정, 남은 지적)',
    '- 남은 일과 사용자 결정(내린 것과 기다리는 것)',
  ]
}

function snapshotBlock(items: string[]) {
  const kept = [...items]
  const size = () => [header, ...kept].join('\n').length
  while (kept.length && size() > snapshotLimit) kept.pop()
  return [header, ...kept].join('\n')
}

export function registerCompactSnapshot(on: On, lead: Holder) {
  on('session.compact', async ($, e, next) => {
    // 블록을 못 만들어도 압축은 막지 않는다.
    const mark = e.agentId ? undefined : await leadOf($, lead).catch(() => undefined)
    const block = snapshotBlock(mark ? await leadItems($, mark.role, mark.since) : commonItems)
    // 사용자나 tfx_control 이 준 지시문을 앞에 그대로 두고 블록을 뒤에 붙인다.
    const instructions = e.instructions?.trim() ? `${e.instructions}\n\n${block}` : block
    return next({ ...e, instructions })
  })
}
