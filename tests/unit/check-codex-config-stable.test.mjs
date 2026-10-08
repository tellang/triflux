// tests/unit/check-codex-config-stable.test.mjs
// Issue #193 follow-up — `[hooks.state.*]` whitelist 가드 단위 테스트.
//
// describeChange 가 sha 변경을 hooks.state-only / 다른 section 변경으로
// 정확히 분류해야 npm test 도중 일어나는 oh-my-codex trust_hash 갱신을
// false positive 로 잡지 않는다.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  classifySectionDiff,
  describeChange,
  splitTomlSections,
} from "../../scripts/check-codex-config-stable.mjs";

const HOOKS_STATE_BLOCK_BEFORE = `[hooks.state."/Users/tellang/.codex/hooks.json:stop:0:0"]
trusted_hash = "sha256:0585a6"

[hooks.state."/Users/tellang/.codex/hooks.json:user_prompt_submit:0:0"]
trusted_hash = "sha256:624a4a"
`;

const HOOKS_STATE_BLOCK_AFTER = `[hooks.state."/Users/tellang/.codex/hooks.json:stop:0:0"]
trusted_hash = "sha256:NEWHASH1"

[hooks.state."/Users/tellang/.codex/hooks.json:user_prompt_submit:0:0"]
trusted_hash = "sha256:NEWHASH2"
`;

const MCP_BLOCK = `[mcp_servers.context7]
url = "https://mcp.context7.com/mcp"
`;

const MCP_BLOCK_DRIFTED = `[mcp_servers.context7]
url = "https://mcp.example.com/mcp"
`;

const PROFILE_BLOCK = `[profiles.codex53_low]
model = "gpt-5.3-codex"
`;

const OPENAI_RUNTIME_PLUGIN_BLOCK = `[plugins."pdf@openai-primary-runtime"]
enabled = true

[marketplaces.openai-primary-runtime]
source = "/Users/tellang/.cache/codex-runtimes/codex-primary-runtime/plugins/openai-primary-runtime"
`;

const OPENAI_RUNTIME_PLUGIN_BLOCK_AFTER = `[plugins."pdf@openai-primary-runtime"]
enabled = true
version = "26.601.10930"

[marketplaces.openai-primary-runtime]
source = "/Users/tellang/.cache/codex-runtimes/codex-primary-runtime/plugins/openai-primary-runtime"
last_sync = "2026-06-18T00:00:00Z"
`;

function snapshot(raw) {
  return {
    exists: true,
    size: Buffer.byteLength(raw, "utf8"),
    mtimeMs: 0,
    sha: createHash("sha256").update(raw).digest("hex"),
    raw,
  };
}

describe("#193 splitTomlSections", () => {
  it("captures preamble before first header as empty-key section", () => {
    const raw = `# top comment\nkey = "value"\n\n[a]\nx = 1\n`;
    const sections = splitTomlSections(raw);
    assert.equal(sections.length, 2);
    assert.equal(sections[0].header, "");
    assert.match(sections[0].body, /key = "value"/);
    assert.equal(sections[1].header, "a");
    assert.match(sections[1].body, /x = 1/);
  });

  it("trims spaces inside header brackets", () => {
    const raw = `[ hooks.state."abc" ]\nv = 1\n`;
    const sections = splitTomlSections(raw);
    assert.equal(sections[1].header, `hooks.state."abc"`);
  });
});

describe("#193 classifySectionDiff", () => {
  it("returns hooksStateOnly=false when payloads are identical", () => {
    const raw = HOOKS_STATE_BLOCK_BEFORE + MCP_BLOCK;
    const result = classifySectionDiff(raw, raw);
    assert.equal(result.hooksStateOnly, false);
    assert.deepEqual(result.changedSections, []);
  });

  it("flags hooks.state-only churn as whitelisted", () => {
    const before = `${MCP_BLOCK}\n${HOOKS_STATE_BLOCK_BEFORE}`;
    const after = `${MCP_BLOCK}\n${HOOKS_STATE_BLOCK_AFTER}`;
    const result = classifySectionDiff(before, after);
    assert.equal(result.hooksStateOnly, true);
    assert.equal(result.externalChurnOnly, true);
    assert.equal(result.changedSections.length, 2);
    for (const header of result.changedSections) {
      assert.match(header, /^hooks\.state\./);
    }
  });

  it("flags OpenAI primary runtime plugin churn as external-only", () => {
    const before = `${MCP_BLOCK}\n${OPENAI_RUNTIME_PLUGIN_BLOCK}`;
    const after = `${MCP_BLOCK}\n${OPENAI_RUNTIME_PLUGIN_BLOCK_AFTER}`;
    const result = classifySectionDiff(before, after);
    assert.equal(result.hooksStateOnly, false);
    assert.equal(result.externalChurnOnly, true);
    assert.deepEqual(result.changedSections.sort(), [
      "marketplaces.openai-primary-runtime",
      'plugins."pdf@openai-primary-runtime"',
    ]);
  });

  it("rejects whitelist when an mcp server section also drifts", () => {
    const before = `${MCP_BLOCK}\n${HOOKS_STATE_BLOCK_BEFORE}`;
    const after = `${MCP_BLOCK_DRIFTED}\n${HOOKS_STATE_BLOCK_AFTER}`;
    const result = classifySectionDiff(before, after);
    assert.equal(result.hooksStateOnly, false);
    assert.equal(result.externalChurnOnly, false);
    assert.ok(
      result.changedSections.some((h) => h === "mcp_servers.context7"),
      `expected mcp_servers.context7 in ${JSON.stringify(result.changedSections)}`,
    );
  });

  it("rejects whitelist when an unrelated section is added", () => {
    const before = HOOKS_STATE_BLOCK_BEFORE;
    const after = `${HOOKS_STATE_BLOCK_AFTER}\n${PROFILE_BLOCK}`;
    const result = classifySectionDiff(before, after);
    assert.equal(result.hooksStateOnly, false);
    assert.equal(result.externalChurnOnly, false);
    assert.ok(result.changedSections.includes("profiles.codex53_low"));
  });
});

describe("#193 describeChange", () => {
  it("returns null when before and after are identical", () => {
    const raw = `${MCP_BLOCK}${HOOKS_STATE_BLOCK_BEFORE}`;
    const before = snapshot(raw);
    const after = snapshot(raw);
    assert.equal(describeChange(before, after), null);
  });

  it("classifies hooks.state-only churn as sha-changed + hooksStateOnly=true", () => {
    const before = snapshot(`${MCP_BLOCK}\n${HOOKS_STATE_BLOCK_BEFORE}`);
    const after = snapshot(`${MCP_BLOCK}\n${HOOKS_STATE_BLOCK_AFTER}`);
    const change = describeChange(before, after);
    assert.ok(change !== null, "expected change");
    assert.equal(change.kind, "sha-changed");
    assert.equal(change.hooksStateOnly, true);
    assert.equal(change.externalChurnOnly, true);
    assert.ok(change.message.startsWith("sha256 differs"));
  });

  it("classifies OpenAI runtime plugin churn as externalChurnOnly=true", () => {
    const before = snapshot(`${MCP_BLOCK}\n${OPENAI_RUNTIME_PLUGIN_BLOCK}`);
    const after = snapshot(
      `${MCP_BLOCK}\n${OPENAI_RUNTIME_PLUGIN_BLOCK_AFTER}`,
    );
    const change = describeChange(before, after);
    assert.ok(change !== null, "expected change");
    assert.equal(change.kind, "sha-changed");
    assert.equal(change.hooksStateOnly, false);
    assert.equal(change.externalChurnOnly, true);
  });

  it("classifies mcp server mutation as sha-changed + hooksStateOnly=false", () => {
    const before = snapshot(`${MCP_BLOCK}\n${HOOKS_STATE_BLOCK_BEFORE}`);
    const after = snapshot(`${MCP_BLOCK_DRIFTED}\n${HOOKS_STATE_BLOCK_BEFORE}`);
    const change = describeChange(before, after);
    assert.ok(change !== null, "expected change");
    assert.equal(change.kind, "sha-changed");
    assert.equal(change.hooksStateOnly, false);
    assert.equal(change.externalChurnOnly, false);
  });

  it("rejects whitelist when hooks.state churn is mixed with other section drift", () => {
    const before = snapshot(`${MCP_BLOCK}\n${HOOKS_STATE_BLOCK_BEFORE}`);
    const after = snapshot(`${MCP_BLOCK_DRIFTED}\n${HOOKS_STATE_BLOCK_AFTER}`);
    const change = describeChange(before, after);
    assert.ok(change !== null, "expected change");
    assert.equal(change.kind, "sha-changed");
    assert.equal(change.hooksStateOnly, false);
    assert.ok(
      change.changedSections.includes("mcp_servers.context7"),
      `expected mcp_servers.context7 in ${JSON.stringify(change.changedSections)}`,
    );
  });

  it("flags mtime-only drift even when sha matches", () => {
    const raw = `${MCP_BLOCK}${HOOKS_STATE_BLOCK_BEFORE}`;
    const before = snapshot(raw);
    const after = { ...snapshot(raw), mtimeMs: before.mtimeMs + 1000 };
    const change = describeChange(before, after);
    assert.ok(change !== null, "expected change");
    assert.equal(change.kind, "mtime-only");
  });
});
