import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const adrDir = join(repoRoot, "docs", "adr");

const adrFiles = () =>
  existsSync(adrDir) ? readdirSync(adrDir).filter((f) => /^\d{4}-.+\.md$/.test(f)) : [];

test("docs/adr exists with status board + conventions", () => {
  assert.ok(existsSync(adrDir), "docs/adr/ must exist");
  assert.ok(existsSync(join(adrDir, "README.md")), "status board (README.md) must exist");
  assert.ok(existsSync(join(adrDir, "CONVENTIONS.md")), "CONVENTIONS.md must exist");
});

test("bootstrap ADRs present and follow required-heading contract", () => {
  const files = adrFiles();
  assert.ok(files.length >= 2, "expect at least ADR-0001 and ADR-0002");
  for (const f of files) {
    const body = readFileSync(join(adrDir, f), "utf8");
    assert.ok(body.includes("## 결정"), `${f} missing required heading '## 결정'`);
    assert.ok(body.includes("## 검토한 대안"), `${f} missing required heading '## 검토한 대안'`);
  }
});

test("every ADR is registered in the status board", () => {
  const board = readFileSync(join(adrDir, "README.md"), "utf8");
  for (const f of adrFiles()) {
    const id = f.slice(0, 4);
    assert.ok(board.includes(`[${id}]`), `ADR ${id} not registered in docs/adr/README.md status board`);
  }
});
