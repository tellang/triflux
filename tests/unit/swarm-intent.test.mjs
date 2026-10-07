import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseIntentTrailer } from "../../hub/team/swarm-intent.mjs";

describe("swarm-intent parser", () => {
  it("parses a valid X-Intent trailer", () => {
    assert.deepEqual(
      parseIntentTrailer('commit\n\nX-Intent: {"scope":"api"}'),
      {
        scope: "api",
      },
    );
  });

  it("returns null for missing or malformed trailers", () => {
    assert.equal(parseIntentTrailer("no trailer here"), null);
    assert.equal(parseIntentTrailer("X-Intent: not-json"), null);
    assert.equal(parseIntentTrailer(""), null);
  });
});
