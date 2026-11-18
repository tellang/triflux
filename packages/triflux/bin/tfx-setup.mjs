#!/usr/bin/env node
import { fileURLToPath } from "node:url";

process.argv = [
  process.argv[0],
  // triflux.mjs의 isMainModule()이 이 심 대신 본체 경로를 보므로 argv[1]을 본체로 맞춘다.
  fileURLToPath(new URL("./triflux.mjs", import.meta.url)),
  "setup",
  ...process.argv.slice(2),
];
await import("./triflux.mjs");
