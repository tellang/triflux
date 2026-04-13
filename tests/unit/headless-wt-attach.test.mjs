import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const headlessSrc = readFileSync(
  join(import.meta.dirname, "../../hub/team/headless.mjs"),
  "utf8",
);

describe("headless wt-manager migration", () => {
  it("createWtManager를 import한다", () => {
    assert.ok(headlessSrc.includes('from "./wt-manager.mjs"'));
  });

  it("buildWtAttachPaneArgs가 제거되었다", () => {
    assert.ok(!headlessSrc.includes("function buildWtAttachPaneArgs"));
    assert.ok(!headlessSrc.includes("export function buildWtAttachPaneArgs"));
  });

  it("spawnDetachedWt가 제거되었다", () => {
    assert.ok(!headlessSrc.includes("function spawnDetachedWt"));
  });

  it("buildDashboardAttachArgs가 존재한다", () => {
    assert.ok(headlessSrc.includes("export function buildDashboardAttachArgs"));
  });

  it("buildWtAttachArgs가 제거되었다", () => {
    assert.ok(!headlessSrc.includes("export function buildWtAttachArgs"));
  });

  it("wt.exe 직접 spawn이 없다", () => {
    // execFileSync("wt.exe" 또는 spawn("wt.exe" 패턴이 없어야 함
    assert.ok(!headlessSrc.match(/(?:spawn|execFile(?:Sync)?)\s*\(\s*["']wt\.exe/));
  });
});
