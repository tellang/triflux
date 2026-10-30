import type { EngineInterface, On, ProcessRunInit, ToolCallResult } from 'claude-code'

function structuredMessage(message: string) {
  try {
    const parsed = JSON.parse(message)
    return parsed !== null && typeof parsed === 'object'
  } catch {
    return false
  }
}

function missingRecipient(result: ToolCallResult<'SendMessage'>) {
  const body = result.result
  if (!result.isError && !(body && typeof body === 'object' && 'success' in body && body.success === false)) return false
  const text = result.text ?? (typeof body === 'string' ? body : body && typeof body === 'object' && 'message' in body && typeof body.message === 'string' ? body.message : '')
  return /no (?:agent|session|recipient) (?:named|found|with\b)|(?:agent|session|recipient)\b[^\n]*\b(?:not found|does not exist|doesn't exist)|unknown (?:agent|session|recipient)/i.test(text)
}

async function processOptions($: EngineInterface): Promise<ProcessRunInit> {
  const pid = await $.env.get('CLAUDE_PID')
  return { stdin: '', timeoutMs: 30_000, env: { CLAUDECODE: '1', ...(pid ? { CLAUDE_PID: pid } : {}) } }
}

function sendFailure(error: unknown, attempted: boolean, returned: boolean) {
  const detail = error instanceof Error ? error.message : String(error)
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  // 시작 실패를 증명하지 못하면 timeout 등으로 이미 전달됐을 수 있다.
  const uncertain = attempted && (returned || !/\b(?:ENOENT|EACCES|ENOEXEC)\b/.test(`${code} ${detail}`))
  return {
    uncertain,
    answer: { deny: uncertain
      ? `결과 불명. 이미 들어갔을 수 있으니 재전송하지 말고 상대 회신을 확인하라 (${detail}).`
      : `전송 실패: ${detail}.` },
  }
}

async function sendPeer($: EngineInterface, to: string, message: string) {
  let attempted = false
  let returned = false
  try {
    const options = await processOptions($)
    attempted = true
    const process = await $.process.run(['tfx-peer', 'send', '--to', to, '--message', message], options)
    returned = true
    if (process.isStdoutTruncated) throw new Error('tfx-peer output truncated')
    if (process.exitCode === 1 && !process.stdout.trim())
      return { uncertain: false, answer: { deny: `전송 실패: ${process.stderr.trim() || 'exit 1'}.` } }
    let data: { status: string; error?: string }
    try {
      data = JSON.parse(process.stdout)
    } catch (error) {
      throw new Error(process.stderr.trim() || (error instanceof Error ? error.message : String(error)))
    }
    if (!data || !['written', 'sent', 'partial', 'unknown'].includes(data.status)) throw new Error('Invalid tfx-peer send result')
    if (process.exitCode === 0 && (data.status === 'written' || data.status === 'sent'))
      return { uncertain: false, answer: { result: `${to} 세션에 native peer 경로로 넣었다 (${data.status}).` } }
    if (data.status === 'partial' || data.status === 'unknown')
      return { uncertain: true, answer: { deny: `결과 불명. 이미 들어갔을 수 있으니 재전송하지 말고 상대 회신을 확인하라 (${data.status}${data.error ? `, ${data.error}` : ''}).` } }
    return { uncertain: false, answer: { deny: `전송 실패: exit ${process.exitCode}${data.error ? `, ${data.error}` : ''}.` } }
  } catch (error) {
    return sendFailure(error, attempted, returned)
  }
}

export function registerNativeMessage(on: On) {
  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    if (typeof e.to !== 'string' || typeof e.message !== 'string' || structuredMessage(e.message)) return next(e)
    if (/^codex:/i.test(e.to)) return (await sendPeer($, `codex:${e.to.slice(6)}`, e.message)).answer
    if (/^(?:agy|antigravity):/i.test(e.to)) return (await sendPeer($, `agy:${e.to.replace(/^(?:agy|antigravity):/i, '')}`, e.message)).answer
    const original = await next(e)
    if (!missingRecipient(original) || /^(?:claude|codex|agy|antigravity):/i.test(e.to)) return original
    const sent = await sendPeer($, `agy:${e.to}`, e.message)
    return sent.uncertain || !('deny' in sent.answer) ? sent.answer : original
  })

  on('tool.call', { tool: 'ListAgents' }, async ($, e, next) => {
    const original = await next(e)
    if (original.deny || original.isError || typeof original.result?.listing !== 'string') return original
    try {
      const rows: string[] = []
      for (const cli of ['codex', 'agy']) {
        const process = await $.process.run(['tfx-live', 'list-sessions', '--cli', cli], { stdin: '', timeoutMs: 10_000 })
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
