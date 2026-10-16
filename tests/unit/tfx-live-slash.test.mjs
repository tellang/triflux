import assert from "node:assert/strict";
import { test } from "node:test";
import { ADAPTERS, doAskViaTmux, isSlashCommand } from "../../bin/tfx-live.mjs";

test("슬래시 명령과 실제 경로로 시작하는 문장을 구분한다", () => {
  for (const prompt of ["/rename 새 이름", "/clear", "/tfx-review 봐줘"])
    assert.equal(isSlashCommand(prompt), true, prompt);
  for (const prompt of [
    "/tmp 내용을 확인해줘",
    "/Users/me/a.txt 열어",
    "안녕 /clear",
  ])
    assert.equal(isSlashCommand(prompt), false, prompt);
});

for (const prompt of ["/rename 10.16 새 이름", "/status", "/compact", "/new"]) {
  const slashCommand = prompt.startsWith("/rename") || prompt === "/status";
  for (const ifBusy of slashCommand
    ? [undefined, "wait", "queue", "fail", "interrupt"]
    : ["wait"]) {
    test(`Codex busy 상태에서 ${prompt.split(" ")[0]}가 ${ifBusy ?? "기본"} 정책을 따른다`, async () => {
      const immediate =
        slashCommand && [undefined, "wait", "queue"].includes(ifBusy);
      const calls = [];
      let busy = true;
      const asking = doAskViaTmux(
        ADAPTERS.codex,
        {
          session: "busy-codex",
          prompt,
          noWait: !slashCommand,
          skipContextGuard: true,
          ifBusy,
          timeoutMs: 1000,
          busyTimeoutMs: 1000,
          pollIntervalMs: 1,
          settleMs: 0,
        },
        {
          paneCliProcess: async () => ({ pid: 101, foreground: true }),
          capturePane: async () => "›",
          captureVisible: async () => {
            if (!busy) return "›";
            calls.push("busy");
            if (ifBusy !== "interrupt") busy = false;
            return "• Working (0s • esc to interrupt)\n›";
          },
          runTmux: async (_remote, args) => {
            calls.push(args[0]);
            if (args[0] === "paste-buffer") assert.equal(busy, immediate);
            if (args[0] === "send-keys" && args.at(-1) === "Escape") {
              assert.equal(ifBusy, "interrupt");
              calls.push("interrupt");
              busy = false;
            }
            return { stdout: "" };
          },
          sleep: async () => {},
        },
      );
      if (ifBusy === "fail") {
        await assert.rejects(asking, /target busy \(--if-busy fail\)/);
        assert.deepEqual(calls, ["busy"]);
        return;
      }
      const result = await asking;
      assert.equal(result.inputSent, true);
      assert.equal(result.status, "submitted");
      assert.equal(Boolean(result.slashCommand), slashCommand);
      assert.equal(calls.includes("busy"), !immediate);
      assert.ok(calls.includes("send-keys"));
      if (ifBusy === "interrupt") {
        assert.equal(calls.filter((call) => call === "interrupt").length, 1);
        assert.ok(calls.indexOf("interrupt") < calls.indexOf("paste-buffer"));
      }
      if (immediate) assert.equal(result.busyWaitedMs, 0);
    });
  }
}
