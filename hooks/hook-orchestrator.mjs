#!/usr/bin/env node
// ADR-0023 전환 stub. 다음 릴리스에서 지운다.
import { readFileSync } from "node:fs";
import { cleanupLegacyHooks } from "../scripts/lib/legacy-hook-cleanup.mjs";

try {
  readFileSync(0);
  cleanupLegacyHooks();
} catch {
  // 오래된 Claude hook이 남아 있어도 세션 시작을 막지 않는다.
}
