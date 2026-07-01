#!/usr/bin/env node
// tfx-setup — triflux setup 바로가기
import { fileURLToPath } from "node:url";

process.argv = [
  process.argv[0],
  // triflux.mjs's own isMainModule() guard compares this against its real
  // path, not this shim's — point argv[1] at triflux.mjs so it recognizes
  // itself as the entry point instead of silently no-op'ing.
  fileURLToPath(new URL("./triflux.mjs", import.meta.url)),
  "setup",
  ...process.argv.slice(2),
];
await import("./triflux.mjs");
