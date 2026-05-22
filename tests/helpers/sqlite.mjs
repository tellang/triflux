import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let cached;
let cachedCtor;

export function getBetterSqlite3UnavailableReason() {
  if (cached !== undefined) return cached;

  try {
    const mod = require("better-sqlite3");
    const Database = mod.default ?? mod;
    const probe = new Database(":memory:");
    probe.prepare("SELECT 1").get();
    probe.close();
    cachedCtor = Database;
    cached = "";
    return cached;
  } catch (error) {
    cached = `better-sqlite3 native binding unavailable in this environment: ${error.message}`;
    return cached;
  }
}

export const SQLITE_SKIP = getBetterSqlite3UnavailableReason() || false;

export function loadBetterSqlite3ForTest() {
  const reason = getBetterSqlite3UnavailableReason();
  if (reason) throw new Error(reason);
  if (cachedCtor) return cachedCtor;
  const mod = require("better-sqlite3");
  cachedCtor = mod.default ?? mod;
  return cachedCtor;
}
