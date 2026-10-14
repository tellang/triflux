import type { EngineInterface, On, ToolCallResult } from 'claude-code'

type PeerTarget = { cli: string; name: string; target?: string | null }
type SendResult = {
  ok: boolean
  to?: PeerTarget
  transport?: string
  status?: string
  reason?: string
  error?: string
  candidates?: PeerTarget[]
}

function structuredMessage(message: string) {
  try {
    const parsed = JSON.parse(message)
    return parsed !== null && typeof parsed === 'object'
  } catch {
    return false
  }
}

function missingRecipient(result: ToolCallResult<'SendMessage'>) {
  if (!result.isError) return false
  const text = result.text ?? (typeof result.result === 'string' ? result.result : '')
  return /no (?:agent|session|recipient) (?:named|found|with\b)|(?:agent|session|recipient)\b[^\n]*\b(?:not found|does not exist|doesn't exist)|unknown (?:agent|session|recipient)/i.test(text)
}

async function send($: EngineInterface, to: string, message: string) {
  // PATH 에 없거나 실행·파싱이 실패하면 호출자가 원래 도구 결과를 쓴다.
  const process = await $.process.run(['tfx-live', 'send', '--to', to, '--message', message, '--no-wait'], { stdin: '' })
  if (process.isStdoutTruncated) throw new Error('tfx-live output truncated')
  const data: SendResult = JSON.parse(process.stdout)
  if (!data || typeof data.ok !== 'boolean') throw new Error('Invalid tfx-live send result')
  if (data.ok && process.exitCode === 0) {
    if (!data.to || typeof data.to.cli !== 'string' || typeof data.to.name !== 'string' || typeof data.transport !== 'string')
      throw new Error('Invalid tfx-live send target')
    return { reason: data.reason, answer: { result: `${data.to.cli}:${data.to.name} 세션에 ${data.transport} 경로로 넣었다 (${data.status ?? 'sent'}).` } }
  }
  const candidates = (data.candidates ?? []).map(candidate => `${candidate.cli}:${candidate.name}${candidate.target ? ` (${candidate.target})` : ''}`)
  return {
    reason: data.reason,
    answer: { deny: `전송 실패: ${data.reason ?? `exit ${process.exitCode}`}${data.error ? `, ${data.error}` : ''}. 후보: ${candidates.length ? candidates.join(', ') : '없음'}.` },
  }
}

export function registerNativeMessage(on: On) {
  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    if (typeof e.to !== 'string' || typeof e.message !== 'string' || structuredMessage(e.message)) return next(e)
    if (/^(?:codex|agy|antigravity):/.test(e.to)) {
      try {
        return (await send($, e.to, e.message)).answer
      } catch {
        return next(e)
      }
    }
    const original = await next(e)
    if (!missingRecipient(original)) return original
    try {
      const sent = await send($, e.to, e.message)
      return sent.reason === 'use-send-message' ? original : sent.answer
    } catch {
      return original
    }
  })

  on('tool.call', { tool: 'ListAgents' }, async ($, e, next) => {
    const original = await next(e)
    if (original.deny || original.isError || typeof original.result?.listing !== 'string') return original
    try {
      const rows: string[] = []
      for (const cli of ['codex', 'agy']) {
        const process = await $.process.run(['tfx-live', 'list-sessions', '--cli', cli], { stdin: '' })
        if (process.exitCode !== 0 || process.isStdoutTruncated) return original
        const data = JSON.parse(process.stdout)
        if (!data?.ok || !Array.isArray(data.sessions)) return original
        for (const session of data.sessions) {
          const name = session.name || session.panes?.[0]?.name || session.session
          if (typeof name === 'string' && name) rows.push(`${cli}:${name}`)
        }
      }
      if (!rows.length) return original
      // ref 와 text 를 남기면 core 가 원래 표시를 재사용하므로 바꾼 결과를 다시 그리게 한다.
      return { result: { ...original.result, listing: `${original.result.listing}\n\n${rows.join('\n')}` }, context: original.context, isReadOnly: original.isReadOnly }
    } catch {
      return original
    }
  })
}
