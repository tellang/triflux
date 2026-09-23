import { readFileSync } from "node:fs";

import { DELEGATOR_SCHEMA_URL } from "./contracts.mjs";

let schemaBundleCache = null;

export function loadDelegatorSchemaBundle() {
  if (schemaBundleCache) {
    return schemaBundleCache;
  }

  schemaBundleCache = JSON.parse(readFileSync(DELEGATOR_SCHEMA_URL, "utf8"));
  return schemaBundleCache;
}
