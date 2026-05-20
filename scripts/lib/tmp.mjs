import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function resolveTmpDir({ env = process.env, cwd = process.cwd() } = {}) {
  const candidate = env.TFX_TMP || tmpdir();
  try {
    mkdirSync(candidate, { recursive: true });
    return candidate;
  } catch {
    const fallback = join(cwd, ".tfx-tmp");
    try {
      mkdirSync(fallback, { recursive: true });
    } catch {
      // Bash printed the fallback path even when mkdir failed.
    }
    return fallback;
  }
}

export function resolveJobsDir({
  env = process.env,
  tmpDir = resolveTmpDir({ env }),
} = {}) {
  return env.TFX_JOBS_DIR || join(tmpDir, "tfx-jobs");
}
