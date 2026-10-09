import type { Register } from 'claude-code'

import { registerAgentEffort } from './agent-effort.ts'
import { registerHudBand } from './hud-band.tsx'

export const register: Register = (on, options) => {
  registerHudBand(on, options)
  registerAgentEffort(on)
}
