import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const SKILL_PATH = join(process.cwd(), "skills/tfx-auto/SKILL.md");

test("tfx-auto 기본 dispatch는 mode를 생략하고 headless에서만 native bridge를 쓴다", () => {
  const content = readFileSync(SKILL_PATH, "utf8");
  const autoDispatch = /Bash\("tfx multi --auto-attach --dashboard --assign/u;

  assert.match(
    content,
    autoDispatch,
    "기본 tfx multi dispatch는 teammate mode를 생략해야 함",
  );
  assert.match(
    content,
    /--teammate-mode headless.*native bridge.*default.*on/su,
    "명시적 headless의 native bridge 기본-on 정책을 설명해야 함",
  );
  assert.match(
    content,
    /--no-native-bridge-ui/u,
    "tfx-auto docs should expose the native bridge UI opt-out flag",
  );
});
