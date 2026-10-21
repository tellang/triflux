import type { EngineInterface, On, Timer } from 'claude-code'

type PressureLevel = 1 | 2 | 4

export type PressureState = {
  confirmed?: PressureLevel
  candidate?: PressureLevel
  sampledAt?: number
  lastValid?: { level: PressureLevel; sampledAt: number }
}

export function advancePressure(state: PressureState, level: PressureLevel | null, now: number): {
  state: PressureState
  transition?: { prev: PressureLevel; level: PressureLevel }
} {
  const next: PressureState = { ...state, sampledAt: now, candidate: undefined }
  if (level === null) return { state: next }
  next.lastValid = { level, sampledAt: now }
  if (state.confirmed === undefined) return { state: { ...next, confirmed: level } }
  if (state.sampledAt !== undefined && now - state.sampledAt > 5000) return { state: next }
  if (level === state.confirmed) return { state: next }
  if (level !== state.candidate) return { state: { ...next, candidate: level } }
  return { state: { ...next, confirmed: level }, transition: { prev: state.confirmed, level } }
}

export type Monitor = {
  interactive: boolean
  platform?: Promise<boolean>
  state: PressureState
  active?: { sessionId: string; reading: boolean; submitting: boolean; timer?: Timer }
}

function isMacOS($: EngineInterface, monitor: Monitor) {
  monitor.platform ??= $.process.run(['uname', '-s'])
    .then(result => result.exitCode === 0 && result.stdout.trim() === 'Darwin')
    .catch(() => false)
  return monitor.platform
}

// $.prompt.submit 은 세션이 쉴 때만 턴을 연다. 피어 메시지는 도는 턴 안에도 닿으므로 먼저 자기 세션에 보낸다.
async function notifyLead($: EngineInterface, text: string, isActive: () => boolean) {
  let reason: string
  try {
    const sessionId = await $.session.id()
    const result = await $.process.run(['tfx-peer', 'self', '--session', sessionId, '--message', text], { stdin: '', timeoutMs: 10_000 })
    let data: { status?: string; error?: string } = {}
    try {
      data = JSON.parse(result.stdout)
    } catch {
      // 실패하면 stdout 이 비어 있고 이유는 stderr 에 있다.
    }
    if (result.exitCode === 0 && data.status === 'written') return
    reason = data.status ? `${data.status}${data.error ? `, ${data.error}` : ''}` : result.stderr || `exit ${result.exitCode}`
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error)
  }
  // 보내는 사이 /tfx-pressure off 나 세션 종료로 감시가 꺼졌으면 폴백하지 않는다.
  if (!isActive()) return
  // 스택이나 긴 출력이 프롬프트에 그대로 들어가지 않게 한 줄로 자른다.
  reason = reason.replace(/\s+/g, ' ').trim().slice(0, 200)
  await $.prompt.submit({ text: `${text}\n피어 메시지 전송이 실패해 턴이 끝난 뒤 도착하는 prompt.submit 으로 보냈다 (${reason}).` })
}

function stopMemoryPressure(monitor: Monitor) {
  monitor.active?.timer?.cancel()
  monitor.active = undefined
}

function startMemoryPressure($: EngineInterface, monitor: Monitor, sessionId: string) {
  if (!monitor.interactive || monitor.active?.sessionId === sessionId) return
  stopMemoryPressure(monitor)
  monitor.state = {}
  const current: NonNullable<Monitor['active']> = { sessionId, reading: false, submitting: false }
  monitor.active = current
  current.timer = $.clock.every(2000, async () => {
    if (current.reading) return
    current.reading = true
    try {
      const sessionId = await $.session.id()
      const key = 'tfx.pressure.' + current.sessionId
      const lead = await $.store.get(key)
      if (!lead) {
        if (monitor.active === current) stopMemoryPressure(monitor)
        return
      }
      if (sessionId !== current.sessionId) {
        await $.store.set('tfx.pressure.' + sessionId, lead)
        await $.store.delete(key)
        current.sessionId = sessionId
      }
      let level: PressureLevel | null = null
      try {
        const result = await $.process.run(['sysctl', '-n', 'kern.memorystatus_vm_pressure_level'])
        const value = result.stdout.trim()
        if (result.exitCode === 0 && (value === '1' || value === '2' || value === '4')) {
          level = Number(value) as PressureLevel
        }
      } catch {
        // 실패한 측정도 unknown 표본으로 보내 연속 후보를 끊는다.
      }
      const now = await $.clock.now()
      if (monitor.active !== current) return
      const result = advancePressure(monitor.state, level, now)
      monitor.state = result.state
      if (result.transition && !current.submitting) {
        let { prev, level } = result.transition
        current.submitting = true
        ;(async () => {
          try {
            do {
              const now = await $.clock.now()
              const text = `[memory-pressure] 압박 단계가 ${prev} 에서 ${level} 로 바뀌었다 (${new Date(now).toISOString()}). tfx-lead 스킬 "압박 변화 대응" 절의 그 전이 행에 따라, 실행 중인 세션은 옮길 수 없다는 전제로 지금 할 일을 정해 실행하라. 그 사이 또 바뀌었을 수 있으니 /tfx-pressure status 로 현재 단계를 확인한다.`
              await notifyLead($, text, () => monitor.active === current).catch(() => {})
              if (monitor.active !== current) return
              prev = level
              level = monitor.state.confirmed!
            } while (prev !== level)
          } finally {
            current.submitting = false
          }
        })().catch(() => {})
      }
    } finally {
      current.reading = false
    }
  })
}

// /tfx-pressure on 과 /tfx-lead <역할> 이 같이 쓴다.
export async function enablePressure($: EngineInterface, monitor: Monitor) {
  if (!monitor.interactive) return '메모리 압박 감시는 대화형 세션에서만 지원'
  if (!await isMacOS($, monitor)) return '메모리 압박 감시는 macOS 에서만 지원'
  const sessionId = await $.session.id()
  await $.store.set('tfx.pressure.' + sessionId, { since: new Date(await $.clock.now()).toISOString() })
  startMemoryPressure($, monitor, sessionId)
  return '메모리 압박 감시: on'
}

export function registerMemoryPressure(on: On, monitor: Monitor) {
  // 같은 이벤트를 필터 없이 등록하면 HUD 훅과 겹쳐 로드가 거부된다. isInteractive 로 나눠 둘 다 받는다.
  for (const isInteractive of [true, false]) {
    on('session.start', { isInteractive }, async ($, e, next) => {
      monitor.interactive = e.isInteractive
      stopMemoryPressure(monitor)
      monitor.state = {}
      await $.command.register({ name: 'tfx-pressure', description: '메모리 압박 감시: on|off|status' })
      const sessionId = await $.session.id()
      if (monitor.interactive && await $.store.get('tfx.pressure.' + sessionId) && await isMacOS($, monitor)) {
        startMemoryPressure($, monitor, sessionId)
      }
      return next(e)
    })
  }
  on('session.end', { reason: ['prompt_input_exit', 'resume', 'logout', 'other'] }, async ($, e, next) => {
    await $.store.delete('tfx.pressure.' + e.sessionId)
    return next(e)
  })
  on('command.run', { command: 'tfx-pressure' }, async ($, e) => {
    const sessionId = await $.session.id()
    const key = 'tfx.pressure.' + sessionId
    switch (e.args.trim()) {
      case 'on':
        return { text: await enablePressure($, monitor) }
      case 'off': {
        // /clear 직후면 등록이 아직 옛 ID 키에 있을 수 있어 둘 다 지운다.
        const activeId = monitor.active?.sessionId
        stopMemoryPressure(monitor)
        await $.store.delete(key)
        if (activeId && activeId !== sessionId) await $.store.delete('tfx.pressure.' + activeId)
        return { text: '메모리 압박 감시: off' }
      }
      case 'status': {
        const lead = await $.store.get(key)
        const sample = monitor.state.lastValid
        return { text: `압박 감시: ${lead ? 'on' : 'off'}. 마지막 유효 표본: ${sample ? `${sample.level} (${new Date(sample.sampledAt).toISOString()})` : '없음'}. 마지막 확정 단계: ${monitor.state.confirmed ?? '없음'}.` }
      }
      default:
        return { text: '사용법: /tfx-pressure on|off|status' }
    }
  })
}
