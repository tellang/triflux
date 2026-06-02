import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cmdCto } from "../../cto/index.mjs";

async function captureStdout(fn) {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => {
    lines.push(args.join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

describe("cmdCto", () => {
  it("prints usage when no subcommand is provided", async () => {
    const output = await captureStdout(() => cmdCto([]));

    assert.match(output, /Usage/u);
    assert.match(output, /tfx cto <collect\|status\|dashboard>/u);
    assert.match(output, /collect/u);
    assert.match(output, /status/u);
    assert.match(output, /dashboard/u);
  });

  it("prints usage for an unknown subcommand without throwing", async () => {
    const output = await captureStdout(() => cmdCto(["bogus"]));

    assert.match(output, /Unknown cto subcommand: bogus/u);
    assert.match(output, /Usage/u);
  });
});
