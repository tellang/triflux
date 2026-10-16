import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
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
it("Windows setup skips peer approval without writing", async () => {
  const x = fixture();
  try {
    const r = await offerPeerPermission({
      ...x,
      platform: "win32",
      interactive: true,
      ask: async () => {
        throw Error("must not ask");
      },
    });
    assert.equal(r.status, "unsupported");
    assert.deepEqual(fs.readdirSync(x.home), []);
  } finally {
    cleanup(x);
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
