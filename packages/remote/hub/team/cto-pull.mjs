import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveRoleControlSnapshot } from "@triflux/core/hub/lib/cto-env.mjs";

function defaultLakeRoot() {
  return join(process.cwd(), ".triflux", "lake");
}

/**
 * Read the CTO north-star lake snapshot without affecting runtime control flow.
 * @param {object} [opts]
 * @param {string} [opts.lakeRoot] Directory containing current.json.
 * @param {object} [opts.env] Environment values used for the CTO kill-switch.
 * @returns {object|null}
 */
export function readCtoSnapshot(opts = {}) {
  if (!resolveRoleControlSnapshot(opts.env).north_star_enabled) return null;
  try {
    const lakeRoot = opts.lakeRoot || defaultLakeRoot();
    const parsed = JSON.parse(
      readFileSync(join(lakeRoot, "current.json"), "utf8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
