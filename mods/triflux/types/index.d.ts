export type BandSpan = { text: string; color?: string; bold?: boolean; dim?: boolean }

// statusLine HUD 가 --band 로 그린 줄들. columns 는 그때 넘긴 폭이다.
export type BandRows = { columns: number; lines: BandSpan[][] }

declare module 'claude-code' {
  interface PluginState {
    'triflux-mods': { rows: BandRows | null }
  }
}
