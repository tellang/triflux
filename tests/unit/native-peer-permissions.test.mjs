import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { it } from "node:test";
import { main } from "../../bin/tfx-peer.mjs";
import {
  inspectPeerPermission,
  installPeerPermission,
  offerPeerPermission,
  peerPermissionPlan,
} from "../../scripts/lib/native-peer-permissions.mjs";

const fixture = () => {
  const home = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "tfx-peer-test-")),
  );
  const prefix = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "tfx-peer-prefix-")),
  );
  const packageRoot = path.join(prefix, "lib", "node_modules", "triflux");
  const nodePath = path.join(prefix, "bin", "node");
  const tmuxPath = path.join(prefix, "bin", "tmux");
  fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
  fs.mkdirSync(path.dirname(nodePath));
  fs.writeFileSync(nodePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  fs.writeFileSync(tmuxPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  fs.writeFileSync(
    path.join(packageRoot, "bin", "tfx-peer.mjs"),
    "// fixture\n",
    { mode: 0o644 },
  );
  return { home, packageRoot, nodePath, tmuxPath, prefix };
};
const cleanup = (x) => {
  fs.rmSync(x.home, { recursive: true, force: true });
  fs.rmSync(x.prefix, { recursive: true, force: true });
};
const writeHosts = (home, hosts) => {
  const file = path.join(home, ".config", "triflux", "hosts.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ hosts }));
  return file;
};
it("decline and noninteractive write nothing", async () => {
  for (const mode of ["decline", "noninteractive"]) {
    const x = fixture();
    try {
      const result = await offerPeerPermission({
        ...x,
        interactive: mode !== "noninteractive",
        ask: async () => false,
      });
      assert.notEqual(result.status, "approved");
      assert.deepEqual(fs.readdirSync(x.home), []);
    } finally {
      cleanup(x);
    }
  }
});
it("busy offer identifies its exact lock without removing it", async () => {
  const x = fixture();
  try {
    const plan = peerPermissionPlan(x);
    const lock = `${plan.manifest}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "other install", { mode: 0o600 });
    const warnings = [];
    const result = await offerPeerPermission({
      ...x,
      interactive: true,
      ask: async () => true,
      warn: (message) => warnings.push(message),
    });
    assert.equal(result.status, "busy");
    assert.ok(warnings.some((message) => message.includes(lock)));
    assert.equal(fs.readFileSync(lock, "utf8"), "other install");
  } finally {
    cleanup(x);
  }
});
it("post-consent conflict and partial warnings identify only the peer allow entry", async () => {
  for (const variant of ["conflict", "partial"]) {
    const x = fixture();
    try {
      const plan = peerPermissionPlan(x);
      const warnings = [];
      const originalRename = fs.renameSync;
      if (variant === "partial") {
        fs.renameSync = (from, to) => {
          originalRename(from, to);
          if (to === plan.wrapper) throw new Error("fixture write failure");
        };
      }
      let result;
      try {
        result = await offerPeerPermission({
          ...x,
          interactive: true,
          ask: async () => {
            if (variant === "conflict") {
              fs.mkdirSync(path.dirname(plan.rule), { recursive: true });
              fs.writeFileSync(plan.rule, "unmanaged rule");
            }
            return true;
          },
          warn: (message) => warnings.push(message),
        });
      } finally {
        fs.renameSync = originalRename;
      }
      assert.equal(result.status, variant);
      assert.ok(warnings.some((message) => message.includes(plan.settings)));
      assert.ok(warnings.some((message) => message.includes(plan.allow)));
      if (variant === "conflict")
        assert.equal(fs.readFileSync(plan.rule, "utf8"), "unmanaged rule");
    } finally {
      cleanup(x);
    }
  }
});
it("preserves existing allow/deny and installs exact wrapper/rule", () => {
  const x = fixture();
  try {
    const p = peerPermissionPlan(x);
    fs.mkdirSync(path.dirname(p.settings), { recursive: true });
    fs.writeFileSync(
      p.settings,
      JSON.stringify({
        permissions: { allow: ["Read"], deny: ["Bash(curl:*)"] },
        foo: 1,
      }),
    );
    const r = installPeerPermission({ ...x, consent: true });
    assert.equal(r.status, "approved");
    const s = JSON.parse(fs.readFileSync(p.settings));
    assert.deepEqual(s.permissions.deny, ["Bash(curl:*)"]);
    assert.ok(s.permissions.allow.includes("Read"));
    assert.ok(s.permissions.allow.includes(p.allow));
    assert.match(
      fs.readFileSync(p.wrapper, "utf8"),
      /unset NODE_OPTIONS NODE_PATH/,
    );
    assert.equal(fs.statSync(p.wrapper).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(p.rule, "utf8"), p.codexRule);
    assert.ok(!p.codexRule.includes('"node"'));
    assert.ok(!p.codexRule.includes('"bash"'));
    assert.equal(inspectPeerPermission(x).status, "approved");
  } finally {
    cleanup(x);
  }
});
it("a git repository at the prefix does not block peer approval", () => {
  const x = fixture();
  try {
    fs.mkdirSync(path.join(x.prefix, ".git"));
    assert.equal(
      installPeerPermission({ ...x, consent: true }).status,
      "approved",
    );
    assert.equal(inspectPeerPermission(x).status, "approved");
  } finally {
    cleanup(x);
  }
});
it("trusted owner-group-writable package, Node and tmux paths are eligible", () => {
  const x = fixture();
  try {
    for (const dir of [
      x.prefix,
      path.join(x.prefix, "lib"),
      path.join(x.prefix, "bin"),
      x.packageRoot,
    ])
      fs.chmodSync(dir, 0o775);
    assert.equal(
      installPeerPermission({ ...x, consent: true }).status,
      "approved",
    );
    const script = fs.readFileSync(peerPermissionPlan(x).wrapper, "utf8");
    assert.ok(script.includes(path.dirname(x.tmuxPath)));
  } finally {
    cleanup(x);
  }
});
it("other-writable pinned tmux is never approved", () => {
  const x = fixture();
  try {
    fs.chmodSync(x.tmuxPath, 0o777);
    assert.equal(
      installPeerPermission({ ...x, consent: true }).status,
      "unavailable",
    );
    assert.deepEqual(fs.readdirSync(x.home), []);
  } finally {
    cleanup(x);
  }
});
it("manual revocation or wrapper mutation is not silently restored", async () => {
  const x = fixture();
  try {
    installPeerPermission({ ...x, consent: true });
    const p = peerPermissionPlan(x);
    fs.writeFileSync(p.wrapper, "changed");
    assert.equal(inspectPeerPermission(x).status, "modified");
    const r = await offerPeerPermission({
      ...x,
      interactive: true,
      fromUpdate: true,
      ask: async () => {
        throw Error("must not ask during update");
      },
    });
    assert.equal(r.status, "modified");
    assert.equal(fs.readFileSync(p.wrapper, "utf8"), "changed");
  } finally {
    cleanup(x);
  }
});
it("wrapper drops Node startup injection and passes shell metacharacters only as data", () => {
  const x = fixture();
  try {
    const fake = x.nodePath;
    const marker = path.join(x.home, "bad");
    const attackerPath = path.join(x.home, "shadow-bin");
    fs.mkdirSync(attackerPath);
    for (const name of ["ps", "tmux"])
      fs.writeFileSync(
        path.join(attackerPath, name),
        `#!/bin/sh\ntouch ${marker}\n`,
        { mode: 0o700 },
      );
    fs.writeFileSync(
      fake,
      '#!/bin/sh\nprintf "%s|%s|%s|%s\\n" "$NODE_OPTIONS" "$NODE_PATH" "$PATH" "$*"\n',
      { mode: 0o700 },
    );
    const r = installPeerPermission({ ...x, nodePath: fake, consent: true });
    assert.equal(r.status, "approved");

    const p = spawnSync(
      peerPermissionPlan({ ...x, nodePath: fake }).wrapper,
      ["send", "--to", "codex:exact", "--message", `hello; touch ${marker}`],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${attackerPath}:${process.env.PATH}`,
          NODE_OPTIONS: "--inspect",
          NODE_PATH: "/evil",
        },
      },
    );
    assert.equal(p.status, 0);
    assert.ok(p.stdout.startsWith("||"));
    assert.ok(!p.stdout.includes(attackerPath));
    assert.match(p.stdout, /hello; touch/);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    cleanup(x);
  }
});
it("approved wrapper refuses packageRoot replaced by a dev symlink before loading code", async () => {
  const x = fixture();
  try {
    fs.writeFileSync(x.nodePath, '#!/bin/sh\nexec /bin/sh "$@"\n', {
      mode: 0o700,
    });
    const entry = path.join(x.packageRoot, "bin", "tfx-peer.mjs");
    fs.writeFileSync(entry, '#!/bin/sh\nprintf "STABLE\\n"\n');
    assert.equal(
      installPeerPermission({ ...x, consent: true }).status,
      "approved",
    );
    const wrapper = peerPermissionPlan(x).wrapper;
    const first = spawnSync(wrapper, ["send"], { encoding: "utf8" });
    assert.equal(first.status, 0);
    assert.equal(first.stdout, "STABLE\n");
    const dev = path.join(x.home, "dev");
    fs.mkdirSync(path.join(dev, "bin"), { recursive: true });
    fs.mkdirSync(path.join(dev, ".git"));
    fs.writeFileSync(
      path.join(dev, "bin", "tfx-peer.mjs"),
      '#!/bin/sh\nprintf "DEV\\n"\n',
    );
    fs.rmSync(x.packageRoot, { recursive: true });
    fs.symlinkSync(dev, x.packageRoot);
    const second = spawnSync(wrapper, ["send"], { encoding: "utf8" });
    assert.equal(second.status, 126);
    assert.equal(second.stdout, "");
    assert.match(second.stderr, /untrusted package tree/);
    assert.equal(inspectPeerPermission(x).status, "unavailable");
    const notices = [];
    const offered = await offerPeerPermission({
      ...x,
      interactive: true,
      fromUpdate: true,
      ask: async () => {
        throw Error("must not regrant");
      },
      notice: (message) => notices.push(message),
    });
    assert.equal(offered.status, "unavailable");
    assert.deepEqual(notices, []);
    assert.equal(fs.existsSync(wrapper), true);
  } finally {
    cleanup(x);
  }
});
it("missing or symlink adapter entry never grants", () => {
  const x = fixture();
  try {
    const entry = path.join(x.packageRoot, "bin", "tfx-peer.mjs");
    fs.unlinkSync(entry);
    assert.equal(
      installPeerPermission({ ...x, consent: true }).status,
      "unavailable",
    );
    fs.symlinkSync("/dev/null", entry);
    assert.equal(
      installPeerPermission({ ...x, consent: true }).status,
      "unavailable",
    );
    assert.deepEqual(fs.readdirSync(x.home), []);
  } finally {
    cleanup(x);
  }
});
it("unmanaged rule and modified wrapper fail closed even with fresh consent", () => {
  for (const variant of ["unmanaged-rule", "modified-wrapper"]) {
    const x = fixture();
    try {
      const p = peerPermissionPlan(x);
      if (variant === "unmanaged-rule") {
        fs.mkdirSync(path.dirname(p.rule), { recursive: true });
        fs.writeFileSync(
          p.rule,
          'prefix_rule(pattern=["danger"], decision="forbidden")\n',
        );
      } else {
        installPeerPermission({ ...x, consent: true });
        fs.writeFileSync(p.wrapper, "#!/bin/sh\necho changed\n");
      }
      const original = fs.readFileSync(
        variant === "unmanaged-rule" ? p.rule : p.wrapper,
        "utf8",
      );
      assert.equal(
        installPeerPermission({ ...x, consent: true }).status,
        "conflict",
      );
      assert.equal(
        fs.readFileSync(
          variant === "unmanaged-rule" ? p.rule : p.wrapper,
          "utf8",
        ),
        original,
      );
    } finally {
      cleanup(x);
    }
  }
});
it("concurrent Claude settings deny edit is not overwritten", () => {
  const x = fixture();
  try {
    const p = peerPermissionPlan(x);
    fs.mkdirSync(path.dirname(p.settings), { recursive: true });
    fs.writeFileSync(
      p.settings,
      JSON.stringify({ permissions: { deny: ["Read"] } }),
    );
    const originalRename = fs.renameSync;
    let result;
    try {
      fs.renameSync = (from, to) => {
        originalRename(from, to);
        if (to === p.wrapper)
          fs.writeFileSync(
            p.settings,
            JSON.stringify({
              permissions: {
                deny: ["Read", "Bash(tfx-peer:*)"],
              },
            }),
          );
      };
      result = installPeerPermission({ ...x, consent: true });
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(result.status, "partial");
    assert.equal(result.retrySafe, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(p.settings)).permissions.deny, [
      "Read",
      "Bash(tfx-peer:*)",
    ]);
  } finally {
    cleanup(x);
  }
});
it("reconsent keeps only the newest dedicated Claude settings backup", () => {
  const x = fixture();
  try {
    const p = peerPermissionPlan(x);
    fs.mkdirSync(path.dirname(p.settings), { recursive: true });
    fs.writeFileSync(
      p.settings,
      JSON.stringify({ permissions: { deny: ["Read"] } }),
    );
    assert.equal(
      installPeerPermission({ ...x, consent: true }).status,
      "approved",
    );
    const oldBackup = fs
      .readdirSync(path.dirname(p.settings))
      .find((name) => name.startsWith("settings.json.tfx-peer-backup-"));
    const settings = JSON.parse(fs.readFileSync(p.settings));
    settings.permissions.allow = [];
    fs.writeFileSync(p.settings, JSON.stringify(settings));
    assert.equal(
      installPeerPermission({ ...x, consent: true }).status,
      "approved",
    );
    const backups = fs
      .readdirSync(path.dirname(p.settings))
      .filter((name) => name.startsWith("settings.json.tfx-peer-backup-"));
    assert.equal(backups.length, 1);
    assert.notEqual(backups[0], oldBackup);
    assert.deepEqual(JSON.parse(fs.readFileSync(p.settings)).permissions.deny, [
      "Read",
    ]);
  } finally {
    cleanup(x);
  }
});
it("approved wrapper or parent becoming writable is no longer approved", () => {
  const x = fixture();
  try {
    installPeerPermission({ ...x, consent: true });
    const p = peerPermissionPlan(x);
    fs.chmodSync(p.wrapper, 0o777);
    assert.equal(inspectPeerPermission(x).status, "conflict");
    fs.chmodSync(p.wrapper, 0o700);
    fs.chmodSync(path.dirname(p.wrapper), 0o777);
    assert.equal(inspectPeerPermission(x).status, "conflict");
  } finally {
    cleanup(x);
  }
});
it("dev checkout and writable package/runtime tree cannot be globally approved", () => {
  for (const variant of [
    "git",
    "nested-git-case",
    "node-modules-git",
    "bin-mode",
    "import-mode",
    "prefix-mode",
    "node-bin-mode",
    "node-target-mode",
    "node-escape",
  ]) {
    const x = fixture();
    try {
      if (variant === "git") fs.mkdirSync(path.join(x.packageRoot, ".git"));
      if (variant === "nested-git-case")
        fs.mkdirSync(path.join(x.packageRoot, "bin", ".GIT"));
      if (variant === "node-modules-git")
        fs.mkdirSync(path.join(x.prefix, "lib", "node_modules", ".git"));
      if (variant === "bin-mode")
        fs.chmodSync(path.join(x.packageRoot, "bin"), 0o777);
      if (variant === "import-mode") {
        const dir = path.join(x.packageRoot, "hub");
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, "module.mjs"), "// unsafe\n", {
          mode: 0o666,
        });
        fs.chmodSync(path.join(dir, "module.mjs"), 0o666);
      }
      if (variant === "prefix-mode")
        fs.chmodSync(path.join(x.prefix, "lib"), 0o777);
      if (variant === "node-bin-mode")
        fs.chmodSync(path.join(x.prefix, "bin"), 0o777);
      if (variant === "node-target-mode" || variant === "node-escape") {
        const target =
          variant === "node-escape"
            ? path.join(x.home, "node")
            : path.join(x.prefix, "Cellar", "node", "bin", "node");
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(x.nodePath, target);
        fs.symlinkSync(
          path.relative(path.dirname(x.nodePath), target),
          x.nodePath,
        );
        if (variant === "node-target-mode")
          fs.chmodSync(path.join(x.prefix, "Cellar"), 0o777);
      }
      assert.equal(
        installPeerPermission({ ...x, consent: true }).status,
        "unavailable",
        variant,
      );
      assert.deepEqual(
        fs.readdirSync(x.home),
        variant === "node-escape" ? ["node"] : [],
      );
    } finally {
      cleanup(x);
    }
  }
});

it("Windows approval is unsupported without prompts or filesystem changes", async () => {
  const x = fixture();
  try {
    const options = { ...x, platform: "win32" };
    assert.deepEqual(inspectPeerPermission(options), { status: "unsupported" });
    assert.deepEqual(inspectPeerPermission({ platform: "win32" }), {
      status: "unsupported",
    });
    assert.equal(
      installPeerPermission({ ...options, consent: true }).status,
      "unsupported",
    );
    for (const fromUpdate of [false, true]) {
      const notices = [];
      assert.deepEqual(
        await offerPeerPermission({
          ...options,
          fromUpdate,
          interactive: true,
          ask: () => assert.fail("Windows must not request approval"),
          notice: (message) => notices.push(message),
        }),
        { status: "unsupported", changed: false },
      );
      assert.deepEqual(notices, [
        "Windows 는 자동 승인 없이 tfx-peer 를 직접 실행한다",
      ]);
    }
    assert.deepEqual(fs.readdirSync(x.home), []);
  } finally {
    cleanup(x);
  }
});

it("설치된 로컬 send 승인 규칙은 remote-send와 receiver에 매치하지 않는다", async () => {
  const x = fixture();
  try {
    const p = peerPermissionPlan(x);
    assert.equal(
      installPeerPermission({ ...x, consent: true }).status,
      "approved",
    );
    const rule = fs.readFileSync(p.rule, "utf8");
    const pattern = JSON.parse(
      rule.match(/^prefix_rule\(pattern=(\[.*\]), decision="allow"\)\n$/)[1],
    );
    const settings = JSON.parse(fs.readFileSync(p.settings, "utf8"));
    const bashPrefixes = settings.permissions.allow.map((allow) =>
      allow.slice("Bash(".length, -":*)".length),
    );
    const local = [
      p.wrapper,
      "send",
      "--to",
      "codex:수신",
      "--message",
      "본문",
    ];
    const remote = [
      p.wrapper,
      "remote-send",
      "--host",
      "m5",
      "--reply-host",
      "m2",
      "--to",
      "codex:수신",
      "--message",
      "본문",
    ];
    for (const [argv, expected] of [
      [local, true],
      [remote, false],
      [[p.wrapper, "_receive"], false],
    ]) {
      assert.equal(
        pattern.every((part, i) => argv[i] === part),
        expected,
      );
      const command = argv.join(" ");
      assert.equal(
        bashPrefixes.some(
          (prefix) => command === prefix || command.startsWith(`${prefix} `),
        ),
        expected,
      );
    }
    const { main } = await import("../../bin/tfx-peer.mjs");
    let effects = 0;
    await assert.rejects(
      main([...local.slice(1), "--remote", "m5", "--reply-host", "m2"], {
        env: { TFX_LIVE_FROM: "codex:발신" },
        discover: async () => {
          effects++;
          return [];
        },
        resolveRemoteHost: () => ({ name: "m5", os: "linux" }),
        spawn: () => {
          effects++;
          throw new Error("unexpected SSH");
        },
      }),
      /Invalid peer argument/,
    );
    assert.equal(effects, 0);
    assert.equal(inspectPeerPermission(x).status, "approved");
  } finally {
    cleanup(x);
  }
});
it("remote-send 승인은 따로 묻고 거절하면 send 만 승인한다", async () => {
  const x = fixture();
  try {
    writeHosts(x.home, { m5: { os: "darwin", ssh_user: "tester" } });
    const asked = [];
    const result = await offerPeerPermission({
      ...x,
      interactive: true,
      ask: async (question) => {
        asked.push(question);
        return asked.length === 1;
      },
    });
    assert.equal(result.status, "approved");
    assert.equal(result.remote, "declined");
    assert.equal(asked.length, 2);
    assert.match(asked[1], /remote-send/);
    const p = peerPermissionPlan({ ...x, verb: "remote-send" });
    const settings = JSON.parse(fs.readFileSync(p.settings, "utf8"));
    assert.deepEqual(settings.permissions.allow, [peerPermissionPlan(x).allow]);
    assert.equal(fs.existsSync(p.rule), false);
    assert.equal(fs.existsSync(p.manifest), false);
  } finally {
    cleanup(x);
  }
});

it("remote-send 등록 파일 오류는 목적지 없음과 구분하고 승인 파일을 쓰지 않는다", async () => {
  for (const [variant, expected, guidance] of [
    ["missing", "host-registry-unavailable", "등록 파일이 없다"],
    ["empty", "no-destinations", "목적지가 없다"],
    ["malformed", "host-registry-unavailable", "JSON 형식이 잘못되었다"],
    ["unsafe", "host-registry-unavailable", "소유자나 권한을 신뢰할 수 없다"],
    ["unreadable", "host-registry-unavailable", "읽을 수 없다"],
  ]) {
    const x = fixture();
    try {
      assert.equal(
        installPeerPermission({ ...x, consent: true }).status,
        "approved",
      );
      const hostsPath = peerPermissionPlan({
        ...x,
        verb: "remote-send",
      }).hostsPath;
      if (variant !== "missing") writeHosts(x.home, {});
      if (variant === "malformed")
        fs.writeFileSync(hostsPath, "{private-hosts");
      if (variant === "unsafe") fs.chmodSync(path.dirname(hostsPath), 0o777);
      if (variant === "unreadable") {
        fs.renameSync(hostsPath, `${hostsPath}.actual`);
        fs.symlinkSync(`${hostsPath}.actual`, hostsPath);
      }
      const remote = peerPermissionPlan({ ...x, verb: "remote-send" });
      const inspected = inspectPeerPermission({ ...x, verb: "remote-send" });
      assert.equal(inspected.status, expected, variant);
      if (variant !== "empty")
        assert.ok(inspected.reason.includes(guidance), variant);
      assert.deepEqual(
        installPeerPermission({ ...x, verb: "remote-send", consent: true }),
        { status: expected, changed: false },
        variant,
      );
      const messages = [];
      const result = await offerPeerPermission({
        ...x,
        interactive: true,
        ask: () => assert.fail("등록 파일 오류에는 동의를 묻지 않는다"),
        notice: (message) => messages.push(message),
        warn: (message) => messages.push(message),
      });
      assert.equal(result.remote, expected, variant);
      assert.ok(
        messages.some(
          (message) =>
            message.includes(hostsPath) && message.includes(guidance),
        ),
        variant,
      );
      assert.ok(
        messages.every((message) => !message.includes("{private-hosts")),
        variant,
      );
      assert.equal(fs.existsSync(remote.rule), false, variant);
      assert.equal(fs.existsSync(remote.manifest), false, variant);
      assert.equal(inspectPeerPermission(x).status, "approved", variant);
    } finally {
      cleanup(x);
    }
  }
});

it("remote-send 승인은 래퍼의 remote-send verb 에만 매치한다", async () => {
  const x = fixture();
  try {
    writeHosts(x.home, { m5: { os: "darwin", ssh_user: "tester" } });
    const result = await offerPeerPermission({
      ...x,
      interactive: true,
      ask: async () => true,
    });
    assert.equal(result.remote, "approved");
    const p = peerPermissionPlan({ ...x, verb: "remote-send" });
    assert.equal(
      p.wrapper,
      path.join(x.home, ".claude/scripts/tfx-peer-remote"),
    );
    const settings = JSON.parse(fs.readFileSync(p.settings, "utf8"));
    assert.deepEqual(settings.permissions.allow, [
      peerPermissionPlan(x).allow,
      `Bash(${p.wrapper} remote-send:*)`,
    ]);
    assert.equal(
      fs.readFileSync(p.rule, "utf8"),
      `prefix_rule(pattern=[${JSON.stringify(p.wrapper)}, "remote-send"], decision="allow")\n`,
    );
    assert.equal(
      fs.readFileSync(peerPermissionPlan(x).rule, "utf8"),
      peerPermissionPlan(x).codexRule,
    );
    assert.equal(inspectPeerPermission(x).status, "approved");
    assert.equal(
      inspectPeerPermission({ ...x, verb: "remote-send" }).status,
      "approved",
    );
  } finally {
    cleanup(x);
  }
});

it("update 와 비대화형은 send 동의만 있는 사용자에게 remote-send 를 승인하지 않는다", async () => {
  const x = fixture();
  try {
    writeHosts(x.home, { m5: { os: "darwin", ssh_user: "tester" } });
    installPeerPermission({ ...x, consent: true });
    const p = peerPermissionPlan({ ...x, verb: "remote-send" });
    const before = fs.readFileSync(p.settings, "utf8");
    for (const options of [
      { interactive: true, fromUpdate: true },
      { interactive: false },
    ]) {
      const result = await offerPeerPermission({
        ...x,
        ...options,
        ask: () => assert.fail("update 와 비대화형은 묻지 않는다"),
      });
      assert.equal(result.status, "approved");
      assert.equal(result.changed, false);
      assert.equal(fs.readFileSync(p.settings, "utf8"), before);
      assert.equal(fs.existsSync(p.rule), false);
      assert.equal(fs.existsSync(p.manifest), false);
    }
  } finally {
    cleanup(x);
  }
});

it("사전 승인 래퍼는 등록된 목적지만 보내고 setup에서 다시 동의한 변경만 반영한다", async () => {
  const x = fixture();
  const other = fixture();
  try {
    const m5 = {
      os: "darwin",
      aliases: ["build"],
      ssh: { host: "Build.Example", user: "tester" },
    };
    const hostsFile = writeHosts(x.home, { m5 });
    const otherFile = writeHosts(other.home, { m5 });
    const local = peerPermissionPlan(x);
    installPeerPermission({ ...x, consent: true });
    const preserved = [local.wrapper, local.rule, local.manifest].map((file) =>
      fs.readFileSync(file, "utf8"),
    );
    const prompts = [];
    const approve = () =>
      offerPeerPermission({
        ...x,
        interactive: true,
        ask: async (question) => {
          prompts.push(question);
          return true;
        },
      });
    assert.equal((await approve()).remote, "approved");
    assert.ok(prompts[0].includes(hostsFile));
    assert.match(prompts[0], /m5.*tester@build\.example:22/i);
    assert.match(prompts[0], /재승인/);

    const remote = peerPermissionPlan({ ...x, verb: "remote-send" });
    fs.writeFileSync(x.nodePath, '#!/bin/sh\nshift\nprintf "%s\\0" "$@"\n');
    const env = {
      HOME: other.home,
      TFX_HOSTS_USER_STATE: otherFile,
      TFX_HOSTS_USER_STATE_DISABLE: "1",
    };
    assert.notEqual(spawnSync(remote.wrapper, ["send"], { env }).status, 0);
    const endpoints = [];
    const send = async (alias, target = "codex:수신") => {
      const result = spawnSync(
        remote.wrapper,
        [
          "remote-send",
          "--from",
          "codex:발신",
          "--host",
          alias,
          "--reply-host",
          "m2",
          "--to",
          target,
          "--message",
          "본문",
        ],
        { env, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      return main(result.stdout.split("\0").slice(0, -1), {
        env,
        discover: async () => [],
        spawn: (command, args) => {
          endpoints.push({ command, args });
          const child = new PassThrough();
          child.stdin = new PassThrough();
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          child.stdin.on("data", (body) => {
            child.stdout.end(
              JSON.stringify({
                version: 1,
                correlationId: JSON.parse(body).correlationId,
                stage: "delivery",
                result: {
                  status: "sent",
                  retrySafe: false,
                  modelReceipt: false,
                },
              }),
            );
            child.emit("close", 0);
          });
          return child;
        },
      });
    };
    const m3 = { os: "windows", ssh_user: "tester" };
    writeHosts(x.home, { m5, m3 });
    assert.equal((await send("build")).status, "sent");
    assert.equal(endpoints[0].command, "/usr/bin/ssh");
    assert.ok(endpoints[0].args.includes("tester@build.example"));
    assert.ok(endpoints[0].args.includes("HostName=build.example"));
    assert.ok(endpoints[0].args.includes("CanonicalizeHostname=no"));
    assert.ok(endpoints[0].args.includes("ControlPath=none"));
    assert.ok(endpoints[0].args.includes("22"));
    await assert.rejects(send("m3", "claude:수신"), /approval/i);
    writeHosts(x.home, { m5: { ...m5, os: "windows" }, m3 });
    await assert.rejects(send("m5", "claude:수신"), /approval/i);
    for (const change of [
      { host: "different.example" },
      { user: "other" },
      { port: 2222 },
    ]) {
      writeHosts(x.home, { m5: { ...m5, ssh: { ...m5.ssh, ...change } }, m3 });
      await assert.rejects(send("m5"), /approval/i);
    }
    assert.equal(endpoints.length, 1);

    const before = fs.readFileSync(remote.manifest, "utf8");
    for (const options of [
      { fromUpdate: true, interactive: true },
      { interactive: false },
    ]) {
      const result = await offerPeerPermission({
        ...x,
        ...options,
        ask: () => assert.fail("setup 동의가 필요하다"),
      });
      assert.equal(result.changed, false);
      assert.equal(fs.readFileSync(remote.manifest, "utf8"), before);
    }

    const duringPrompt = await offerPeerPermission({
      ...x,
      interactive: true,
      ask: async () => {
        writeHosts(x.home, {
          m5: { ...m5, ssh: { ...m5.ssh, port: 2223 } },
          m3,
        });
        return true;
      },
    });
    assert.equal(duringPrompt.remote, "conflict");
    assert.equal(fs.readFileSync(remote.manifest, "utf8"), before);
    writeHosts(x.home, { m5: { ...m5, ssh: { ...m5.ssh, port: 2222 } }, m3 });
    assert.equal((await approve()).remote, "approved");
    assert.match(prompts[1], /tester@build\.example:2222/i);
    assert.match(prompts[1], /m3.*Windows/);
    assert.equal((await send("m5")).status, "sent");
    assert.ok(endpoints[1].args.includes("2222"));
    assert.equal((await send("m3")).status, "sent");
    await assert.rejects(send("m3", "agy:수신"), /Windows.*Claude/);
    assert.equal((await send("m3", "claude:수신")).status, "sent");
    assert.match(endpoints[2].args.at(-1), /^pwsh\.exe /);
    assert.deepEqual(endpoints[2].args, endpoints[3].args);
    writeHosts(x.home, { m5, m3: { ...m3, os: "linux" } });
    await assert.rejects(send("m3", "claude:수신"), /approval/i);
    fs.unlinkSync(remote.manifest);
    await assert.rejects(send("m5"), /approval/i);
    assert.equal(endpoints.length, 4);
    assert.deepEqual(
      [local.wrapper, local.rule, local.manifest].map((file) =>
        fs.readFileSync(file, "utf8"),
      ),
      preserved,
    );
  } finally {
    cleanup(x);
    cleanup(other);
  }
});

it("send 승인이 없으면 remote-send 만 승인할 수 없다", () => {
  const x = fixture();
  try {
    const result = installPeerPermission({
      ...x,
      verb: "remote-send",
      consent: true,
    });
    assert.equal(result.status, "requires-send");
    assert.deepEqual(fs.readdirSync(x.home), []);
  } finally {
    cleanup(x);
  }
});
