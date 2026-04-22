import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const LEGACY_SKILLS = [
  { name: "tfx-autopilot", canonical: "tfx-auto" },
  { name: "tfx-consensus", canonical: "tfx-auto --mode consensus" },
  { name: "tfx-debate", canonical: "tfx-auto --mode consensus --shape debate" },
  { name: "tfx-fullcycle", canonical: "tfx-auto --mode deep --parallel 1" },
  { name: "tfx-multi", canonical: "tfx-auto --parallel N --mode deep" },
  { name: "tfx-panel", canonical: "tfx-auto --mode consensus --shape panel" },
  { name: "tfx-persist", canonical: "tfx-auto --retry ralph" },
  {
    name: "tfx-swarm",
    canonical:
      "tfx-auto --parallel swarm --mode consensus --isolation worktree",
  },
  { name: "tfx-remote-setup", canonical: "tfx-remote setup" },
  { name: "tfx-remote-spawn", canonical: "tfx-remote" },
  { name: "tfx-psmux-rules", canonical: ".claude/rules/tfx-psmux.md" },
];

describe("#112 Phase 5 gate — legacy alias deprecation logging", () => {
  for (const { name, canonical } of LEGACY_SKILLS) {
    describe(name, () => {
      const skillPath = resolve(repoRoot, "skills", name, "SKILL.md");
      const content = readFileSync(skillPath, "utf8");

      it("alias-usage.log append 명령을 포함", () => {
        assert.match(
          content,
          />> \.omc\/state\/alias-usage\.log/,
          `${name} SKILL.md 에 alias-usage.log append 라인 누락 — Phase 5 zero-usage 게이트가 측정되지 않음`,
        );
      });

      it("stderr [deprecated] 경고 echo 를 포함", () => {
        assert.match(
          content,
          /echo\s+"\[deprecated\][^"]*"\s+>&2/,
          `${name} SKILL.md 에 stderr [deprecated] echo 누락`,
        );
      });

      it("stdout [DEPRECATED] 마커 echo 를 포함", () => {
        assert.match(
          content,
          /echo\s+"\[DEPRECATED\][^"]*"$/m,
          `${name} SKILL.md 에 stdout [DEPRECATED] 마커 echo 누락`,
        );
      });

      it(`canonical entrypoint "${canonical}" 언급`, () => {
        assert.ok(
          content.includes(canonical),
          `${name} SKILL.md 에 canonical entrypoint (${canonical}) 언급 누락`,
        );
      });

      it("mkdir -p .omc/state 선행", () => {
        assert.match(
          content,
          /mkdir\s+-p\s+\.omc\/state/,
          `${name} SKILL.md 에 mkdir -p .omc/state 누락 — 첫 호출 시 log 디렉토리 부재로 append 실패`,
        );
      });
    });
  }
});
