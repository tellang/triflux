import assert from "node:assert/strict";
import test from "node:test";
import { parseTeamArgs } from "../../hub/team/cli/commands/start/parse-args.mjs";

test("parseTeamArgs honors --no-native-bridge-ui over default-on", () => {
  const result = parseTeamArgs([
    "start",
    "--teammate-mode",
    "headless",
    "--no-native-bridge-ui",
  ]);

  assert.equal(result.nativeBridge, false);
  assert.equal(result.nativeBridgeMode, "agents");
});

test("parseTeamArgs rejects conflicting native bridge UI flags", () => {
  assert.throws(
    () =>
      parseTeamArgs([
        "start",
        "--teammate-mode",
        "headless",
        "--native-bridge-ui",
        "--no-native-bridge-ui",
      ]),
    /cannot combine --native-bridge-ui and --no-native-bridge-ui/,
  );
});
