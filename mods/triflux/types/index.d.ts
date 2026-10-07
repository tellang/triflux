export type UsageWindow = { kind: string; percentUsed: number; resetsAt?: string }

export type UsageSnapshot = {
  windows: UsageWindow[]
  contextPercent: number | null
  costUsd: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'triflux-mods': { usage: UsageSnapshot | null }
  }
}
