import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseClaudeUsageResponse } from "../../hud/providers/claude.mjs";

describe("parseClaudeUsageResponse", () => {
  it("returns null when both keys are missing", () => {
    assert.equal(parseClaudeUsageResponse({}), null);
  });

  it("returns null for non-object input", () => {
    assert.equal(parseClaudeUsageResponse(null), null);
    assert.equal(parseClaudeUsageResponse("string"), null);
  });

  it("parses both buckets with valid utilization", () => {
    const result = parseClaudeUsageResponse({
      five_hour: { utilization: 42, resets_at: "2026-04-22T10:00:00Z" },
      seven_day: { utilization: 13, resets_at: "2026-04-29T10:00:00Z" },
    });
    assert.equal(result.fiveHourPercent, 42);
    assert.equal(result.weeklyPercent, 13);
    assert.equal(result.fiveHourResetsAt, "2026-04-22T10:00:00Z");
    assert.equal(result.weeklyResetsAt, "2026-04-29T10:00:00Z");
  });

  it("treats utilization=null as 0% (no usage in window)", () => {
    const result = parseClaudeUsageResponse({
      five_hour: { utilization: null, resets_at: "2026-04-22T10:00:00Z" },
      seven_day: { utilization: 5, resets_at: "2026-04-29T10:00:00Z" },
    });
    assert.equal(result.fiveHourPercent, 0);
    assert.equal(result.weeklyPercent, 5);
  });

  it("returns null percent when five_hour key is absent (API anomaly, not 0%)", () => {
    const result = parseClaudeUsageResponse({
      seven_day: { utilization: 13, resets_at: "2026-04-29T10:00:00Z" },
    });
    assert.equal(
      result.fiveHourPercent,
      null,
      "missing key must surface as null (--% placeholder), not 0%",
    );
    assert.equal(result.weeklyPercent, 13);
    assert.equal(result.fiveHourResetsAt, null);
  });

  it("returns null percent when seven_day key is absent", () => {
    const result = parseClaudeUsageResponse({
      five_hour: { utilization: 30, resets_at: "2026-04-22T10:00:00Z" },
    });
    assert.equal(result.fiveHourPercent, 30);
    assert.equal(
      result.weeklyPercent,
      null,
      "missing key must surface as null, not 0%",
    );
    assert.equal(result.weeklyResetsAt, null);
  });

  it("clamps out-of-range utilization values", () => {
    const result = parseClaudeUsageResponse({
      five_hour: { utilization: 150 },
      seven_day: { utilization: -5 },
    });
    assert.equal(result.fiveHourPercent, 100);
    assert.equal(result.weeklyPercent, 0);
  });
});
