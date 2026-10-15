import type { Register } from 'claude-code'

import { registerAgentEffort } from './agent-effort.ts'
import { registerHudBand } from './hud-band.tsx'
import { registerMemoryPressure } from './memory-pressure.ts'
import { registerNativeMessage } from './native-message.ts'

export const register: Register = (on, options) => {
  registerHudBand(on, options)
  registerAgentEffort(on)
  registerNativeMessage(on)
  registerMemoryPressure(on)
}
