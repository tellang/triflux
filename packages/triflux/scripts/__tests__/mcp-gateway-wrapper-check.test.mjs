import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { checkWrapperSourcing } from "../lib/mcp-gateway-wrapper-check.mjs";

const tmpRoot = path.join(os.tmpdir(), `triflux-wrapper-check-${randomUUID()}`);

after(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

async function fixturePath(name) {
  await mkdir(tmpRoot, { recursive: true });
  return path.join(tmpRoot, name);
}

describe("mcp-gateway-wrapper-check", () => {
  it("returns ok when wrapper contains secrets.env", async () => {
    const wrapperPath = await fixturePath("ok-wrapper.sh");
    await writeFile(
      wrapperPath,
      'source "$HOME/.config/triflux/secrets.env"\n',
      "utf8",
    );

    const result = await checkWrapperSourcing({ wrapperPath });

    assert.equal(result.status, "ok");
    assert.equal(result.wrapperPath, wrapperPath);
  });

  it("returns warn when wrapper does not contain secrets.env", async () => {
    const wrapperPath = await fixturePath("warn-wrapper.sh");
    await writeFile(wrapperPath, "exec node scripts/mcp-gateway-start.mjs\n");

    const result = await checkWrapperSourcing({ wrapperPath });

    assert.equal(result.status, "warn");
    assert.match(result.suggestedFix, /install-mcp-gateway-startup/);
  });

  it("returns missing when wrapper path does not exist", async () => {
    const wrapperPath = path.join(tmpRoot, "missing-wrapper.sh");

    const result = await checkWrapperSourcing({ wrapperPath });

    assert.equal(result.status, "missing");
    assert.equal(result.wrapperPath, wrapperPath);
  });
});
