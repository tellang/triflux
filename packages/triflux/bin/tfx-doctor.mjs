#!/usr/bin/env node
// tfx-doctor — triflux doctor 바로가기
process.argv = [
  process.argv[0],
  process.argv[1],
  "doctor",
  ...process.argv.slice(2),
];
await import("./triflux.mjs");
