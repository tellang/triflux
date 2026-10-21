import type { Register } from 'claude-code'

import { registerAgentEffort } from './agent-effort.ts'
import { registerHudBand } from './hud-band.tsx'
import { registerLeadRole } from './lead-role.ts'
import { type Monitor, registerMemoryPressure } from './memory-pressure.ts'
import { registerNativeMessage } from './native-message.ts'

export const register: Register = (on, options) => {
  registerHudBand(on, options)
  registerAgentEffort(on)
  registerNativeMessage(on)
  // 압박 감시 상태를 /tfx-pressure 와 /tfx-lead 가 같이 본다.
  const monitor: Monitor = { interactive: false, state: {} }
  registerMemoryPressure(on, monitor)
  registerLeadRole(on, monitor)
}
