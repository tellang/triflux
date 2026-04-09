#!/usr/bin/env node
// tfx-setup — triflux setup 바로가기
process.argv = [
  process.argv[0],
  process.argv[1],
  "setup",
  ...process.argv.slice(2),
];
await import("./triflux.mjs");
