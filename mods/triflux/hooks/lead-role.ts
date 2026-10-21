import type { On } from 'claude-code'

import { enablePressure, type Monitor } from './memory-pressure.ts'

const datePrefix = /^\d{1,2}\.\d{1,2} /

export function leadSessionName(role: string, now: number) {
  if (datePrefix.test(role)) return role
  const date = new Date(now)
  return `${date.getMonth() + 1}.${date.getDate()} ${role}`
}

export function registerLeadRole(on: On, monitor: Monitor) {
  for (const isInteractive of [true, false]) {
    on('session.start', { isInteractive }, async ($, e, next) => {
      await $.command.register({ name: 'tfx-lead', description: '이 세션에 역할 리드를 맡긴다: <역할>', argumentHint: '<역할>' })
      return next(e)
    })
  }
  on('command.run', { command: 'tfx-lead' }, async ($, e) => {
    const role = e.args.trim()
    if (!role) return { text: '사용법: /tfx-lead <역할>' }
    const name = leadSessionName(role, await $.clock.now())
    const pressure = await enablePressure($, monitor)
    // 호스트는 이 훅이 도는 동안의 $.command.run 을 타이머에서 부른 것까지 거부한다.
    // 그래서 마지막 await 뒤에 타이머를 걸어 훅이 끝난 다음에 rename 이 돌게 한다.
    $.clock.after(0, () => $.command.run({ command: 'rename', args: name })
      .catch(() => $.ui.toast(`이름 변경 실패: /rename ${name} 을 직접 실행`)))
    return {
      text: `이름 변경 요청: ${name}. ${pressure}`,
      context: [`이 세션의 리드 역할은 ${role.replace(datePrefix, '')}이다. tfx-lead 스킬을 로드해 그 절차를 따른다.`],
    }
  })
}
