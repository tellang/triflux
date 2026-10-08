import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const DIAGNOSE = resolve("scripts/doctor-diagnose.mjs");

test("진단 번들에 환경변수와 spawn 로그의 프롬프트 원문이 들어가지 않는다", () => {
  const home = mkdtempSync(join(tmpdir(), "tfx-diag-"));
  const secret = `probe-${process.pid}-secret`;
  const logs = join(home, ".triflux", "logs");
  mkdirSync(logs, { recursive: true });
  const trace = {
    ts: new Date().toISOString(),
    event: "spawn",
    command: "claude",
    args: ["--print", `prompt with ${secret}`],
  };
  writeFileSync(
    join(logs, `spawn-trace-${trace.ts.slice(0, 10)}.jsonl`),
    `${JSON.stringify(trace)}\n`,
  );
  try {
    const script = `const { diagnose } = await import(${JSON.stringify(DIAGNOSE)});
      const r = await diagnose({ json: true });
      process.stdout.write("\\nZIP=" + r.zipPath);`;
    const out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { env: { ...process.env, HOME: home, PROBE_SECRET: secret } },
    ).toString();
    const zipPath = out.slice(out.lastIndexOf("ZIP=") + 4).trim();
    const bundle = execFileSync("unzip", ["-p", zipPath]).toString();
    assert.ok(bundle.includes("redacted len="), "trace 가 가려져야 한다");
    assert.ok(!bundle.includes(secret));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
