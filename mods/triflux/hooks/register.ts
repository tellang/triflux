import type { Register } from 'claude-code'

import { registerAgentEffort } from './agent-effort.ts'
import { registerCompactSnapshot } from './compact-snapshot.ts'
import { registerControl } from './control.ts'
import { registerHudBand } from './hud-band.tsx'
import { registerIdleTeammates } from './idle-teammates.ts'
import { type Holder, registerLeadRole } from './lead-role.ts'
import { type Monitor, registerMemoryPressure } from './memory-pressure.ts'
import { registerNativeMessage } from './native-message.ts'
import { registerReportLimit } from './report-limit.ts'

export const register: Register = (on, options) => {
  registerHudBand(on, options)
  registerAgentEffort(on)
  registerNativeMessage(on)
  // 압박 감시 상태를 /tfx-pressure 와 /tfx-lead 가 같이 본다.
  const monitor: Monitor = { interactive: false, state: {} }
  registerMemoryPressure(on, monitor)
  // tfx_control 은 /tfx-lead 가 남긴 리드 표지가 있는 세션에서만 받는다.
  const lead: Holder = {}
  registerLeadRole(on, monitor, lead)
  registerControl(on, lead)
  registerCompactSnapshot(on, lead)
  registerReportLimit(on, lead)
  registerIdleTeammates(on, lead)
}
