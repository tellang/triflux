import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function agentJsonPath({ tmpDir, pid = process.pid }) {
  return join(tmpDir, `tfx-agent-${pid}.json`);
}

export function registerAgent({
  tmpDir,
  pid = process.pid,
  cli = "",
  agent = "",
  started = Math.floor(Date.now() / 1000),
}) {
  mkdirSync(tmpDir, { recursive: true });
  const file = agentJsonPath({ tmpDir, pid });
  writeFileSync(
    file,
    `${JSON.stringify({ pid, cli, agent, started })}\n`,
    "utf8",
  );
  return file;
}

export function removeAgent({ tmpDir, pid = process.pid }) {
  rmSync(agentJsonPath({ tmpDir, pid }), { force: true });
}
