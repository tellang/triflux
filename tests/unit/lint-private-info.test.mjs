import assert from "node:assert/strict";
import test from "node:test";

process.env.TFX_PRIVATE_TERMS = "acme-corp";
const { scanText } = await import("../../scripts/lint-private-info.mjs");

const kinds = (text) => scanText(text).map((finding) => finding.kind);

test("개인 경로, CGNAT 주소, tailnet 이름, 막은 계정명을 잡는다", () => {
  assert.deepEqual(kinds("/Users/jdoe/.codex"), ["home-path"]);
  assert.deepEqual(kinds("C:\\\\Users\\\\jdoe\\\\x"), ["home-path"]);
  assert.deepEqual(kinds("ssh 100.101.102.103"), ["cgnat-ip"]);
  assert.deepEqual(kinds("m1.tail1234.ts.net"), ["tailnet"]);
  assert.deepEqual(kinds("gh auth switch --user acme-corp"), ["account"]);
});

test("자리표시는 통과시키고 찾은 값은 가려서 보인다", () => {
  const text = [
    "/Users/example/.codex C:\\Users\\<user>\\x /c/Users/x",
    "100.64.0.1 192.0.2.10 desk.ts.net host.example.ts.net",
  ].join("\n");
  assert.deepEqual(scanText(text), []);
  assert.equal(scanText("/home/jdoe")[0].value, "j***(4)");
});
