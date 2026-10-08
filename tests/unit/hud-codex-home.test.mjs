import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { getCodexAuthPath } from "../../hud/constants.mjs";
import { getCodexEmail } from "../../hud/providers/codex.mjs";
import { getMicroLine } from "../../hud/renderers.mjs";

const dirs = [];
const savedHome = process.env.CODEX_HOME;

afterEach(() => {
  if (savedHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedHome;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function jwt(email) {
  const payload = Buffer.from(JSON.stringify({ email })).toString("base64url");
  return `h.${payload}.s`;
}

describe("hud: CODEX_HOME 반영", () => {
  it("CODEX_HOME 의 auth.json 에서 경로와 이메일을 읽는다", () => {
    const home = mkdtempSync(join(tmpdir(), "hud-codex-home-"));
    dirs.push(home);
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({ tokens: { id_token: jwt("dev@example.com") } }),
    );
    process.env.CODEX_HOME = home;
    assert.equal(getCodexAuthPath(), join(home, "auth.json"));
    assert.equal(getCodexEmail(), "dev@example.com");
  });
});

describe("hud/renderers: nano 한 줄", () => {
  it("로그아웃 x 표식만 굵은 글씨가 빠진다", () => {
    const render = (codexLoggedOut) =>
      getMicroLine({ display: "--", percent: 0 }, null, null, {
        showAntigravity: false,
        codexLoggedOut,
      });
    const boldX = /\x1b\[1m(?:\x1b\[[0-9;]*m)*x/;
    assert.match(render(false), boldX);
    assert.doesNotMatch(render(true), boldX);
  });
});
