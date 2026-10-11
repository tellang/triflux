import { expect, test } from 'claude-code/testing'

import { parseAnsi } from '../hooks/hud-band.tsx'

test('HUD 의 ANSI 색 코드를 Text 조각으로 바꾼다', async () => {
  const line = '\x1b[0m\x1b[1m\x1b[38;2;232;112;64mc\x1b[0m: \x1b[2m5h:\x1b[0m\x1b[33m 83%\x1b[0m \x1b[48;5;39m\x1b[1m\x1b[97m GCP \x1b[0mend'
  expect(parseAnsi(line)).toEqual([
    { text: 'c', bold: true, color: '#e87040' },
    { text: ': ' },
    { text: '5h:', dim: true },
    { text: ' 83%', color: 'yellow' },
    { text: ' ' },
    { text: ' GCP ', backgroundColor: '#00afff', bold: true, color: 'whiteBright' },
    { text: 'end' },
  ])
})
