import type { EngineInterface, On } from 'claude-code'

import { type Holder, leadOf } from './lead-role.ts'

export const reportLimit = 4000
const headLength = 800
const pathLimit = 20

// 절대 경로, ~/ 경로, 확장자가 있는 상대 경로. 앞 글자 검사로 URL 안의 경로는 뺀다.
const pathPattern = /(?<![\p{L}\p{N}_.:/~-])(?:~?\/[\p{L}\p{N}_.@+-]+(?:\/[\p{L}\p{N}_.@+-]+)+|[\p{L}\p{N}_.-]+(?:\/[\p{L}\p{N}_.@+-]+)+\.[\p{L}\p{N}]+)/gu

export function filePaths(text: string) {
  return [...new Set(Array.from(text.matchAll(pathPattern), match => match[0].replace(/\.+$/, '')))]
}

type Shortened = { kind: 'keep' } | { kind: 'warn'; total: number } | { kind: 'cut'; text: string }

// 리드 규칙상 결과 원문은 파일에 있으므로, 경로가 보일 때만 자른다. 경로가 없으면 원문을 잃으니 자르지 않는다.
// report 는 남길 본문, whole 은 길이를 재고 경로를 찾을 전체 글이다.
export function shorten(report: string, whole = report): Shortened {
  if (whole.length <= reportLimit) return { kind: 'keep' }
  const paths = filePaths(whole)
  if (!paths.length) return { kind: 'warn', total: whole.length }
  const listed = paths.slice(0, pathLimit).map(path => `- ${path}`)
  if (paths.length > pathLimit) listed.push(`- 외 ${paths.length - pathLimit}개`)
  return { kind: 'cut', text: `${report.slice(0, headLength)}\n\n(중략)\n파일 경로:\n${listed.join('\n')}\n원문 ${whole.length}자, 결과 파일 참조` }
}

type Block = { type: string; [field: string]: unknown }

// text 블록과 tool_result 안의 글을 차례로 visit 에 넘긴다. null 을 돌려받은 text 블록은 뺀다.
function mapTexts(content: readonly Block[], visit: (text: string) => string | null): Block[] {
  const mapped: Block[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = visit(block.text)
      if (text !== null) mapped.push({ ...block, text })
    } else if (block.type === 'tool_result' && typeof block.content === 'string') {
      mapped.push({ ...block, content: visit(block.content) ?? '' })
    } else if (block.type === 'tool_result' && Array.isArray(block.content)) {
      mapped.push({ ...block, content: mapTexts(block.content as Block[], visit) })
    } else {
      mapped.push(block)
    }
  }
  return mapped
}

// 하네스가 붙이는 agentId, usage 같은 짧은 블록은 살리고 긴 본문 블록들을 하나로 줄인다.
export function shortenContent(content: readonly Block[]): Shortened & { content?: Block[] } {
  const texts: string[] = []
  mapTexts(content, text => (texts.push(text), text))
  const long = texts.filter(text => text.length > headLength)
  if (!long.length) return { kind: 'keep' }
  const result = shorten(long.join('\n'), texts.join('\n'))
  if (result.kind !== 'cut') return result
  let first = true
  return { ...result, content: mapTexts(content, text => text.length <= headLength ? text : first ? ((first = false), result.text) : null) }
}

async function warn($: EngineInterface, source: string, total: number) {
  await $.ui.toast(`[tfx-lead] ${source} ${total}자가 상한 ${reportLimit}자를 넘었지만 파일 경로가 없어 자르지 않았다. 결과는 파일로 받는다.`)
}

export function registerReportLimit(on: On, lead: Holder) {
  // 이 plugin 의 다른 session.receive 훅에 matcher 가 없어 겹치지 않게 origin 으로 좁힌다.
  on('session.receive', { origin: { kind: /^peer(?:-send-message)?$/ } }, async ($, e, next) => {
    if (e.agentId || e.text.length <= reportLimit || !(await leadOf($, lead))) return next(e)
    const result = shorten(e.text)
    if (result.kind === 'cut') return next({ ...e, text: result.text })
    if (result.kind === 'warn') await warn($, '피어 메시지', result.total)
    return next(e)
  })
  // 서브에이전트 결과는 포그라운드면 Agent 도구 결과로, 백그라운드면 작업 알림으로 리드 대화에 들어온다.
  on('session.append', async ($, e, next) => {
    const isHandback = e.origin.kind === 'task-notification' || (e.origin.kind === 'tool' && e.origin.tool === 'Agent')
    if (e.agentId || !isHandback) return next(e)
    const result = shortenContent(e.message.content)
    if (result.kind === 'keep' || !(await leadOf($, lead))) return next(e)
    if (result.content) return next({ ...e, message: { ...e.message, content: result.content } })
    if (result.kind === 'warn') await warn($, '서브에이전트 결과', result.total)
    return next(e)
  })
}
