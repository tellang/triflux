import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const SKILL_PATH = join(process.cwd(), "skills/tfx-auto/SKILL.md");

test("tfx-auto headless dispatch includes native bridge UI by default", () => {
  const content = readFileSync(SKILL_PATH, "utf8");
  const headlessDispatch =
    /Bash\("tfx multi --teammate-mode headless[\s\S]*?--native-bridge-ui[\s\S]*?--assign/u;

  assert.match(
    content,
    headlessDispatch,
    "headless tfx multi dispatch should include --native-bridge-ui before assignments",
  );
  assert.match(
    content,
    /--no-native-bridge-ui/u,
    "tfx-auto docs should expose the native bridge UI opt-out flag",
  );
});
