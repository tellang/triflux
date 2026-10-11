import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  ADAPTERS,
  agyStepText,
  agyWaitVerdict,
  composerShowsPrompt,
  inspectUnsetEnv,
  withUnsetEnv,
} from "../../bin/tfx-live.mjs";

const ready = "────────────────\n> \n────────────────\n? for shortcuts";
const busy = `${ready}\nesc to cancel`;
const queued = `${ready}\n▸ [tfx-live req=second]\nPress up to edit queued messages`;

function varint(value) {
  const bytes = [];
  do {
    bytes.push((value & 127) | (value > 127 ? 128 : 0));
    value = Math.floor(value / 128);
  } while (value);
  return Buffer.from(bytes);
}

function field(number, bytes) {
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}

function step(type, status, text = "") {
  const payload = field(
    type === 14 ? 19 : 20,
    field(type === 14 ? 2 : 1, Buffer.from(text)),
  );
  return { step_type: type, status, step_payload: payload };
}

const request = step(14, 3, "[tfx-live req=first]\n질문 전체");
const answer = step(15, 3, "최종 응답");

test("agy readiness excludes trust while dismiss banners keep the composer usable", () => {
  assert.equal(ADAPTERS.agy.isReady(ready), true);
  assert.equal(ADAPTERS.agy.isReady(`${ready}\nesc to dismiss`), true);
  assert.equal(ADAPTERS.agy.isReady("Starting Antigravity CLI"), false);
  assert.equal(
    ADAPTERS.agy.isReady(
      "Do you trust the contents of this project?\n> Yes, I trust this folder\n  No, exit",
    ),
    false,
  );
  assert.equal(ADAPTERS.agy.isReady("\x1b[32m> \x1b[0m"), true);
});

test("agy cancel and queued footers are busy without changing Codex or Claude", () => {
  assert.equal(ADAPTERS.agy.isBusy(busy), true);
  assert.equal(ADAPTERS.agy.isBusy(queued), true);
  assert.equal(ADAPTERS.agy.isBusy(ready), false);
  assert.equal(ADAPTERS.agy.isBusy(`${ready}\nesc to dismiss`), false);
  assert.equal(ADAPTERS.codex.isBusy(busy), false);
  assert.equal(ADAPTERS.claude.isBusy(queued), false);
});

test("agy submission ignores prompt history and queued text when its composer is empty", () => {
  const prompt = "[tfx-live req=first]\n첫줄\n다음줄";
  assert.equal(
    composerShowsPrompt(
      "> [tfx-live req=first]\n  첫줄\n  다음줄",
      prompt,
      "agy",
    ),
    true,
  );
  assert.equal(
    composerShowsPrompt(
      `> [tfx-live req=first]\n  응답\n${ready}`,
      prompt,
      "agy",
    ),
    false,
  );
  assert.equal(
    composerShowsPrompt(queued, "[tfx-live req=second]", "agy"),
    false,
  );
  assert.equal(
    composerShowsPrompt("> [tfx-live req=first]", prompt, "codex"),
    true,
  );
  assert.equal(
    composerShowsPrompt("> [tfx-live req=first]", prompt, "claude"),
    true,
  );
});

test("agy protobuf extracts full UTF-8 text past varints and unrelated fields", () => {
  const text = `[tfx-live req=first]\n${"여러 줄 원문\n".repeat(30)}`;
  const payload = Buffer.concat([
    Buffer.from([8, 150, 1]),
    field(101, Buffer.from("ignored")),
    field(
      19,
      Buffer.concat([Buffer.from([8, 1]), field(2, Buffer.from(text))]),
    ),
  ]);
  assert.equal(agyStepText(new Uint8Array(payload), 14), text);
  assert.equal(agyStepText(answer.step_payload, 15), "최종 응답");
  assert.equal(
    agyStepText(field(20, field(7, Buffer.from("tool call"))), 15),
    "",
  );
  assert.throws(
    () => agyStepText(Buffer.from([154, 1, 5, 18]), 14),
    /protobuf length/,
  );
});

test("agy waits for all request steps to finish and the pane to leave busy state", () => {
  const working = [request, answer, { step_type: 132, status: 8 }];
  assert.equal(agyWaitVerdict(working, "first", ready).done, false);
  assert.equal(agyWaitVerdict([request, answer], "first", busy).done, false);
  assert.equal(agyWaitVerdict([request, answer], "first", queued).done, false);
  assert.deepEqual(
    agyWaitVerdict(
      [request, answer, { step_type: 132, status: 3 }],
      "first",
      ready,
    ),
    {
      status: "completed",
      done: true,
      response: "최종 응답",
    },
  );
});

test("agy protobuf skips fixed64 and fixed32 fields before text", () => {
  const payload = Buffer.concat([
    Buffer.from([9]),
    Buffer.alloc(8, 255),
    field(
      19,
      Buffer.concat([
        Buffer.from([13]),
        Buffer.alloc(4, 255),
        field(2, Buffer.from("사용자 입력")),
      ]),
    ),
  ]);
  assert.equal(agyStepText(payload, 14), "사용자 입력");
});

test("agy does not complete an idle request until a model step exists", () => {
  for (const steps of [[request], [request, { step_type: 101, status: 3 }]])
    assert.deepEqual(agyWaitVerdict(steps, "first", ready), {
      status: "working",
      done: false,
      response: "",
    });
  assert.equal(
    agyWaitVerdict([request, step(15, 3)], "first", ready).done,
    true,
  );
});

test("unset-env verification requires readable environment and matches exact names or prefixes", () => {
  const patterns = ["PRIVATE_*", "EXACT"];
  assert.deepEqual(
    inspectUnsetEnv("/usr/local/bin/agy --effort low", patterns, "darwin"),
    {
      readable: false,
      remaining: [],
    },
  );
  assert.deepEqual(
    inspectUnsetEnv("agy PRIVATE_KEY=value", patterns, "darwin"),
    {
      readable: false,
      remaining: [],
    },
  );
  assert.deepEqual(
    inspectUnsetEnv(
      "agy PATH=/usr/bin PRIVATE_KEY=value EXACT=value EXACT_MORE=keep",
      patterns,
      "darwin",
    ),
    {
      readable: true,
      remaining: ["PRIVATE_KEY", "EXACT"],
    },
  );
  assert.deepEqual(inspectUnsetEnv("", patterns, "linux"), {
    readable: false,
    remaining: [],
  });
  assert.deepEqual(
    inspectUnsetEnv(
      "PATH=/usr/bin\0PRIVATE_KEY=value\0EXACT=value\0EXACT_MORE=keep\0",
      patterns,
      "linux",
    ),
    {
      readable: true,
      remaining: ["PRIVATE_KEY", "EXACT"],
    },
  );
  assert.deepEqual(
    inspectUnsetEnv("agy PATH=/usr/bin EXACT_MORE=keep", patterns, "darwin"),
    {
      readable: true,
      remaining: [],
    },
  );
});

test("agy finishes an earlier queued request while the next request runs and isolates responses", () => {
  const steps = [
    request,
    step(15, 3, "중간 응답"),
    answer,
    step(15, 3),
    step(14, 3, "[tfx-live req=second]\n다음 질문"),
    step(15, 8, "다음 응답"),
  ];
  assert.deepEqual(agyWaitVerdict(steps, "first", busy), {
    status: "completed",
    done: true,
    response: "최종 응답",
  });
  assert.deepEqual(agyWaitVerdict(steps, null, busy), {
    status: "working",
    done: false,
    response: "다음 응답",
  });
  assert.equal(
    agyWaitVerdict(
      [request, { step_type: 101, status: 8 }, ...steps.slice(4)],
      "first",
      busy,
    ).done,
    false,
  );
});

test("agy finds the last matching request and distinguishes queued from submitted", () => {
  assert.deepEqual(agyWaitVerdict([request, answer], "second", queued), {
    status: "queued",
    done: false,
    response: "",
  });
  assert.deepEqual(agyWaitVerdict([request, answer], "second", ready), {
    status: "submitted",
    done: false,
    response: "",
  });
  assert.equal(
    agyWaitVerdict([request, answer, request, step(15, 8)], "first", ready)
      .done,
    false,
  );
});

test("unset-env removes pane shell variables for launch and resume without losing Claude assignments", () => {
  const probe = "node -e 'process.stdout.write(JSON.stringify(process.env))'";
  const environment = {
    PATH: process.env.PATH,
    TOSSINVEST_KEY: "secret",
    TOSSINVEST_: "secret",
    OTHER_SECRET: "secret",
    EXACT: "secret",
    EXACT_MORE: "keep",
    KEEP: "keep",
  };
  for (const cli of ["agy", "codex", "claude"]) {
    for (const command of [
      ADAPTERS[cli].launchKeys[0],
      ADAPTERS[cli].resumeById("conversation"),
      ADAPTERS[cli].resumeLast(),
    ]) {
      const probeCommand = command.replace(
        new RegExp(`\\b${cli}(?: .*)?$`),
        probe,
      );
      const cleaned = withUnsetEnv(probeCommand, [
        "TOSSINVEST_*",
        "OTHER_*",
        "EXACT",
      ]);
      const result = JSON.parse(
        execFileSync("/bin/sh", ["-c", cleaned], {
          env: environment,
          encoding: "utf8",
        }),
      );
      assert.equal(result.TOSSINVEST_KEY, undefined);
      assert.equal(result.TOSSINVEST_, undefined);
      assert.equal(result.OTHER_SECRET, undefined);
      assert.equal(result.EXACT, undefined);
      assert.equal(result.EXACT_MORE, "keep");
      assert.equal(result.KEEP, "keep");
      if (cli === "claude") assert.equal(result.DISABLE_OMC, "1");
    }
  }
});

test("unset-env rejects malformed patterns before launching a shell", () => {
  for (const pattern of [
    "",
    "*",
    "FOO*BAR",
    "FOO**",
    "FOO-BAR",
    "FOO;id",
    "$(id)",
    " FOO",
    "1FOO",
  ])
    assert.throws(() => withUnsetEnv("agy", [pattern]), /--unset-env/);
  assert.equal(withUnsetEnv("agy", []), "agy");
});
