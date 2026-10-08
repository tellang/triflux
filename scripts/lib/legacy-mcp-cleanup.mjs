import { execFileSync } from "node:child_process";
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform as osPlatform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const require = createRequire(import.meta.url);
const toml = require("@iarna/toml");
const SERVERS = [
  ["context7", 8100, "npx", ["-y", "@upstash/context7-mcp@latest"], []],
  [
    "brave-search",
    8101,
    "npx",
    ["-y", "@brave/brave-search-mcp-server"],
    ["BRAVE_API_KEY"],
  ],
  ["exa", 8102, "npx", ["-y", "exa-mcp-server"], ["EXA_API_KEY"]],
  ["tavily", 8103, "npx", ["-y", "tavily-mcp@latest"], ["TAVILY_API_KEY"]],
  [
    "jira",
    8104,
    "npx",
    ["-y", "mcp-jira-cloud@latest"],
    ["JIRA_API_TOKEN", "JIRA_EMAIL", "JIRA_INSTANCE_URL"],
  ],
  [
    "serena",
    8105,
    "uvx",
    [
      "--from",
      "git+https://github.com/oraios/serena",
      "serena",
      "start-mcp-server",
    ],
    [],
  ],
  [
    "notion",
    8106,
    "npx",
    ["-y", "@notionhq/notion-mcp-server"],
    ["NOTION_TOKEN"],
  ],
  [
    "notion-guest",
    8107,
    "npx",
    ["-y", "@notionhq/notion-mcp-server"],
    ["NOTION_TOKEN"],
  ],
].map(([name, port, command, args, envVars]) => ({
  name,
  port,
  command,
  args,
  envVars,
}));
const BY_PORT = new Map(SERVERS.map((server) => [server.port, server]));
const LABEL = "com.tellang.mcp-gateway";
const TASK = "MCP Gateway";
const UNIT = "mcp-gateway.service";

function defaultRun(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
}

function fileTarget(file) {
  const entry = lstatSync(file, { throwIfNoEntry: false });
  if (!entry) return null;
  const target = entry.isSymbolicLink() ? realpathSync(file) : file;
  if (!statSync(target).isFile())
    throw new Error(`${file}: 일반 파일이 아닙니다`);
  return target;
}

function ownedUrl(value) {
  if (typeof value !== "string") return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    return null;
  const server = BY_PORT.get(Number(url.port));
  if (!server) return null;
  return {
    server,
    valid:
      !url.username &&
      !url.password &&
      ["/mcp", "/sse"].includes(url.pathname) &&
      !url.search &&
      !url.hash,
  };
}

function envWarning(server, home, env, warnings) {
  const secretFiles = [
    join(home, ".config/triflux/secrets.env"),
    join(home, ".config/triflux/mcp-gateway.env"),
    join(home, ".config/tfx/mcp-gateway.env"),
    join(home, ".mcp-gateway.env"),
  ];
  for (const name of server.envVars) {
    if (env[name]) continue;
    const inFile = secretFiles.some((file) => {
      const target = fileTarget(file);
      return (
        target &&
        new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`, "m").test(
          readFileSync(target, "utf8"),
        )
      );
    });
    warnings.push(
      `${server.name}: ${name} ${inFile ? "secrets.env에만 있음; MCP 클라이언트 환경으로 export 필요" : "값 없음; 환경변수 설정 필요"}`,
    );
  }
}

function patchJson(
  original,
  file,
  home,
  env,
  warnings,
  { withEnv = true } = {},
) {
  const data = JSON.parse(original);
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error(`${file}: JSON 객체가 아닙니다`);
  const groups = [
    data.mcpServers,
    ...Object.values(data.projects ?? {}).map((project) => project?.mcpServers),
  ];
  let count = 0;
  let blocked = false;
  for (const entries of groups) {
    if (entries === undefined) continue;
    if (!entries || typeof entries !== "object" || Array.isArray(entries))
      throw new Error(`${file}: mcpServers 객체가 아닙니다`);
    for (const [name, config] of Object.entries(entries)) {
      if (!config || typeof config !== "object" || Array.isArray(config))
        continue;
      const matches = [config.url, config.httpUrl]
        .map(ownedUrl)
        .filter(Boolean);
      if (!matches.length) continue;
      const server = matches[0].server;
      if (
        matches.length !== 1 ||
        name !== server.name ||
        !matches[0].valid ||
        config.command ||
        config.args ||
        config.env ||
        config.headers ||
        config.httpHeaders ||
        config.auth ||
        config.oauth ||
        config.authProviderType ||
        (config.type && !["http", "sse"].includes(config.type))
      ) {
        warnings.push(
          `${file}: ${name} gateway 항목의 소유 또는 직접 연결 형식을 확인할 수 없음`,
        );
        blocked = true;
        continue;
      }
      const { url, httpUrl, type, ...kept } = config;
      entries[name] = {
        ...kept,
        command: server.command,
        args: server.args,
        ...(withEnv && server.envVars.length
          ? {
              env: {
                ...kept.env,
                ...Object.fromEntries(
                  server.envVars.map((key) => [key, `\${${key}}`]),
                ),
              },
            }
          : {}),
      };
      envWarning(server, home, env, warnings);
      count++;
    }
  }
  return {
    output: count ? `${JSON.stringify(data, null, 2)}\n` : original,
    count,
    blocked,
  };
}

function patchToml(original, file, home, env, warnings) {
  const data = toml.parse(original);
  const lines = original.split(/(?<=\n)/);
  const headers = [];
  let offset = 0;
  for (const line of lines) {
    const match = line.match(
      /^\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\]\s*(?:#.*)?\r?\n?$/,
    );
    if (match)
      headers.push({
        name: match[1] ?? match[2] ?? match[3],
        start: offset,
        body: offset + line.length,
      });
    offset += line.length;
  }
  const allSections = [
    ...original.matchAll(/^\[[^\r\n]+\].*(?:\r?\n|$)/gm),
  ].map((match) => match.index);
  const edits = [];
  let blocked = false;
  for (const header of headers) {
    const end =
      allSections.find((start) => start > header.start) ?? original.length;
    const config = data.mcp_servers?.[header.name];
    const match = ownedUrl(config?.url);
    if (!match) continue;
    const { server } = match;
    const body = original.slice(header.body, end);
    if (
      header.name !== server.name ||
      !match.valid ||
      config.headers ||
      config.http_headers ||
      config.env_http_headers ||
      config.bearer_token_env_var ||
      config.oauth ||
      config.auth ||
      config.command ||
      config.args ||
      config.env_vars ||
      config.env ||
      (config.transport && !["http", "sse"].includes(config.transport)) ||
      (config.type && !["http", "sse"].includes(config.type)) ||
      !/^\s*url\s*=\s*["'][^"']+["']\s*(?:#.*)?$/m.test(body)
    ) {
      warnings.push(
        `${file}: ${header.name} gateway 항목의 소유 또는 직접 연결 형식을 확인할 수 없음`,
      );
      blocked = true;
      continue;
    }
    const kept = body.replace(
      /^[ \t]*(?:url|transport|type)\s*=.*(?:\r?\n|$)/gm,
      "",
    );
    const replacement = `${kept}${kept.endsWith("\n") || !kept ? "" : "\n"}command = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\nenv_vars = ${JSON.stringify(server.envVars)}\n`;
    edits.push({ start: header.body, end, replacement });
    delete config.url;
    delete config.type;
    delete config.transport;
    Object.assign(config, {
      command: server.command,
      args: server.args,
      env_vars: server.envVars,
    });
    envWarning(server, home, env, warnings);
  }
  const preflight = headers.find(
    (header) => header.name === "tfx-gateway-preflight",
  );
  if (preflight) {
    const end =
      allSections.find((start) => start > preflight.start) ?? original.length;
    const config = data.mcp_servers[preflight.name];
    if (
      config.command === "node" &&
      config.args?.length === 1 &&
      isLegacyScript(config.args[0], "codex-gateway-preflight.mjs") &&
      Object.keys(config).every((key) =>
        ["command", "args", "enabled", "startup_timeout_sec"].includes(key),
      )
    ) {
      edits.push({ start: preflight.start, end, replacement: "" });
      delete data.mcp_servers[preflight.name];
    } else {
      warnings.push(`${file}: preflight 항목 소유 확인 실패`);
      blocked = true;
    }
  }
  let output = original;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    output =
      output.slice(0, edit.start) + edit.replacement + output.slice(edit.end);
  for (const [name, config] of Object.entries(data.mcp_servers ?? {})) {
    if (ownedUrl(config?.url)) {
      warnings.push(`${file}: ${name} TOML 표현의 소유 확인 실패`);
      blocked = true;
    }
  }
  try {
    if (!isDeepStrictEqual(toml.parse(output), data))
      throw new Error("TOML 구조 불일치");
  } catch {
    warnings.push(`${file}: 이주 결과 TOML 검증 실패`);
    blocked = true;
  }
  return { output, count: edits.length, blocked };
}

function backupFile(file, content) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let backup = `${file}.tfx-bak-${stamp}`;
  for (let i = 1; existsSync(backup); i++)
    backup = `${file}.tfx-bak-${stamp}-${i}`;
  if (content === undefined)
    copyFileSync(file, backup, constants.COPYFILE_EXCL);
  else writeFileSync(backup, content, { flag: "wx", mode: 0o600 });
  chmodSync(backup, 0o600);
  return backup;
}

function backupStartup(home, file) {
  const directory = join(home, ".config/triflux");
  mkdirSync(directory, { recursive: true });
  return backupFile(join(directory, basename(file)), readFileSync(file));
}

function writeAtomic(file, target, output) {
  const backup = backupFile(file);
  const temp = join(
    dirname(target),
    `.tfx-mcp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    writeFileSync(temp, output, {
      encoding: "utf8",
      flag: "wx",
      mode: statSync(target).mode,
    });
    renameSync(temp, target);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* 임시 파일 없음 */
    }
    throw error;
  }
  return backup;
}

function tryRun(run, command, args) {
  try {
    return { ok: true, output: String(run(command, args) ?? "") };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      stderr: String(error.stderr ?? ""),
      status: error.status,
    };
  }
}

function isLegacyScript(value, filename = "mcp-gateway-start.mjs") {
  if (typeof value !== "string") return false;
  const normalized = value.replaceAll("\\", "/");
  return (
    /\/triflux(?:\/\.worktrees\/[^/]+|\/v?\d+\.\d+\.\d+[^/]*)?\/scripts\//.test(
      normalized,
    ) && normalized.endsWith(`/scripts/${filename}`)
  );
}

function absent(result) {
  if (result.ok) return false;
  const message = `${result.error ?? ""}\n${result.stderr ?? ""}`;
  return /Could not find service|service not found|No such process/i.test(
    message,
  );
}

function removeDarwin(home, run, warnings, uid) {
  const plist = join(home, "Library/LaunchAgents", `${LABEL}.plist`);
  const target = fileTarget(plist);
  if (!target) return { attempted: false, verified: true };
  const parsed = tryRun(run, "plutil", ["-convert", "json", "-o", "-", plist]);
  let data;
  try {
    data = parsed.ok ? JSON.parse(parsed.output) : null;
  } catch {
    data = null;
  }
  if (
    data?.Label !== LABEL ||
    JSON.stringify(data.ProgramArguments) !==
      JSON.stringify([
        "/bin/bash",
        join(home, ".local/bin/mcp-gateway-wrapper.sh"),
      ])
  ) {
    warnings.push(`${plist}: 소유 확인 실패`);
    return { attempted: true, verified: false };
  }
  const backupPath = backupStartup(home, plist);
  const service = `gui/${uid}/${LABEL}`;
  const before = tryRun(run, "launchctl", ["print", service]);
  if (!before.ok && !absent(before)) {
    warnings.push(`${LABEL}: launchctl 상태 확인 실패`);
    return { attempted: true, verified: false, backupPath };
  }
  if (before.ok) {
    const stop = tryRun(run, "launchctl", ["bootout", `gui/${uid}`, plist]);
    const after = tryRun(run, "launchctl", ["print", service]);
    if (!stop.ok || !absent(after)) {
      warnings.push(`${LABEL}: launchctl bootout 또는 해제 검증 실패`);
      return { attempted: true, verified: false, backupPath };
    }
  }
  const wrapper = join(home, ".local/bin/mcp-gateway-wrapper.sh");
  const wrapperTarget = fileTarget(wrapper);
  if (wrapperTarget) {
    const command = readFileSync(wrapperTarget, "utf8").match(
      /^exec\s+'[^']*\/node'\s+'([^']+)'\s*$/m,
    );
    if (isLegacyScript(command?.[1])) {
      backupStartup(home, wrapper);
      unlinkSync(wrapper);
    } else warnings.push(`${wrapper}: 소유 확인 실패, 파일 보존`);
  }
  unlinkSync(plist);
  return { attempted: true, verified: !existsSync(plist), backupPath };
}

function removeLinux(home, run, warnings) {
  const unit = join(home, ".config/systemd/user", UNIT);
  const target = fileTarget(unit);
  if (!target) return { attempted: false, verified: true };
  const body = readFileSync(target, "utf8");
  if (
    !body.includes("Description=Triflux MCP Gateway") ||
    !isLegacyScript(
      body.match(/^ExecStart="[^"\n]*\/node"\s+"([^"\n]+)"\s*$/m)?.[1],
    )
  ) {
    warnings.push(`${unit}: 소유 확인 실패`);
    return { attempted: true, verified: false };
  }
  const backupPath = backupStartup(home, unit);
  const removed = tryRun(run, "systemctl", [
    "--user",
    "disable",
    "--now",
    UNIT,
  ]);
  const after = tryRun(run, "systemctl", [
    "--user",
    "show",
    UNIT,
    "--property=ActiveState",
    "--property=UnitFileState",
  ]);
  if (
    !removed.ok ||
    !after.ok ||
    !/^ActiveState=(?:inactive|failed)$/m.test(after.output) ||
    !/^UnitFileState=disabled$/m.test(after.output)
  ) {
    warnings.push(`${UNIT}: 해제 검증 실패`);
    return { attempted: true, verified: false, backupPath };
  }
  const pending = `${backupPath}.pending`;
  renameSync(unit, pending);
  const reload = tryRun(run, "systemctl", ["--user", "daemon-reload"]);
  if (reload.ok) unlinkSync(pending);
  else {
    renameSync(pending, unit);
    warnings.push(`${UNIT}: daemon-reload 실패, unit 복원`);
  }
  return {
    attempted: true,
    verified: reload.ok && !existsSync(unit),
    backupPath,
  };
}

function runPowerShell(run, script) {
  return tryRun(run, "powershell", [
    "-NoProfile",
    "-Command",
    "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; " +
      script,
  ]);
}

function removeWindows(home, run, warnings) {
  const connect =
    "$s=New-Object -ComObject Schedule.Service; $s.Connect(); $f=$s.GetFolder('\\'); ";
  const queryScript =
    connect +
    `$tasks=@($f.GetTasks(1) | Where-Object { $_.Name -eq '${TASK}' }); if ($tasks.Count -eq 0) { 'null' } else { $t=$tasks[0]; $x=[xml]$t.Xml; @{ xml=$t.Xml; command=[string]$x.Task.Actions.Exec.Command; args=[string]$x.Task.Actions.Exec.Arguments; actions=$x.Task.Actions.ChildNodes.Count } | ConvertTo-Json -Compress }`;
  const query = () => {
    const result = runPowerShell(run, queryScript);
    if (!result.ok) throw new Error(`${TASK}: 작업 상태 확인 실패`);
    return JSON.parse(result.output);
  };
  const task = query();
  if (
    task &&
    (!/[/\\]node\.exe$/i.test(task.command?.replace(/^"|"$/g, "") ?? "") ||
      !isLegacyScript(task.args?.replace(/^"|"$/g, "")) ||
      task.actions !== 1)
  ) {
    warnings.push(`${TASK}: 작업 소유 확인 실패`);
    return { attempted: true, verified: false };
  }
  let backupPath;
  if (task) {
    const directory = join(home, ".config/triflux");
    mkdirSync(directory, { recursive: true });
    backupPath = backupFile(join(directory, "legacy-mcp-task.xml"), task.xml);
    const expected = task.xml.replaceAll("'", "''");
    const removed = runPowerShell(
      run,
      connect +
        `$t=$f.GetTask('${TASK}'); if ($t.Xml -ne '${expected}') { throw 'task changed' }; $t.Enabled=$false; if ($t.State -eq 4) { $t.Stop(0) }; $f.DeleteTask('${TASK}',0)`,
    );
    if (!removed.ok || query() !== null) {
      warnings.push(`${TASK}: 작업 해제 검증 실패`);
      return { attempted: true, verified: false, backupPath };
    }
  }
  const link = join(
    home,
    "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/MCP Gateway.lnk",
  );
  const hadLink = existsSync(link);
  if (hadLink) {
    const quoted = link.replaceAll("'", "''");
    const inspected = runPowerShell(
      run,
      `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${quoted}'); @{command=$s.TargetPath; args=$s.Arguments} | ConvertTo-Json -Compress`,
    );
    const shortcut = inspected.ok ? JSON.parse(inspected.output) : null;
    if (
      shortcut &&
      /[/\\]node\.exe$/i.test(shortcut.command) &&
      isLegacyScript(shortcut.args.replace(/^"|"$/g, ""))
    ) {
      backupStartup(home, link);
      unlinkSync(link);
    } else warnings.push(`${link}: startup link 소유 확인 실패`);
  }
  return {
    attempted: Boolean(task) || hadLink,
    verified: !existsSync(link),
    backupPath,
  };
}

function ownedCommand(command) {
  const tokens = command.match(/^(?:"([^"]+)"|(\S+))\s+(.+)$/);
  if (
    !tokens ||
    !/(?:^|[/\\])(?:node|npm|npx)(?:\.exe)?$/i.test(tokens[1] ?? tokens[2])
  )
    return false;
  if (isLegacyScript(tokens[3].replace(/^["']|["']$/g, ""))) return true;
  return (
    /\bsupergateway\b/.test(command) &&
    /\s--stdio\s/.test(command) &&
    [
      "--outputTransport streamableHttp",
      "--stateful",
      "--streamableHttpPath /mcp",
      "--healthEndpoint /healthz",
    ].every((flag) => command.includes(flag)) &&
    SERVERS.some(
      ({ port, command: executable, args }) =>
        new RegExp(`\\s--port\\s+${port}(?:\\s|$)`).test(command) &&
        command.includes([executable, ...args].join(" ")),
    )
  );
}

function ownedProcesses(run, uid) {
  const listed = tryRun(run, "ps", ["-axo", "pid=,uid=,command="]);
  if (!listed.ok) throw new Error("gateway 프로세스 조회 실패");
  return listed.output.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match || match[2] !== String(uid) || !ownedCommand(match[3]))
      return [];
    const started = tryRun(run, "ps", ["-p", match[1], "-o", "lstart="]);
    if (!started.ok && started.status !== 1)
      throw new Error(`gateway PID ${match[1]}: 시작 시각 확인 실패`);
    if (!started.ok || !started.output.trim()) return [];
    return [
      { pid: match[1], identity: `${started.output.trim()}|${match[3]}` },
    ];
  });
}

function ownedWindowsProcesses(run) {
  const result = runPowerShell(
    run,
    "$me=[Security.Principal.WindowsIdentity]::GetCurrent().Name; $items=@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { $p=$_; if ($p.CommandLine -match 'supergateway|mcp-gateway-start\\.mjs') { $o=Invoke-CimMethod -InputObject $p -MethodName GetOwner; if ($o.ReturnValue -eq 0 -and \"$($o.Domain)\\$($o.User)\" -eq $me) { @{ pid=[string]$p.ProcessId; command=$p.CommandLine; started=[string]$p.CreationDate } } } }); ConvertTo-Json -InputObject $items -Compress",
  );
  if (!result.ok) throw new Error("gateway 프로세스 조회 실패");
  return JSON.parse(result.output)
    .filter(({ command }) => ownedCommand(command))
    .map(({ pid, command, started }) => ({
      pid,
      identity: `${started}|${command}`,
    }));
}

function stopProcesses(run, warnings, platform, uid) {
  const list =
    platform === "win32"
      ? () => ownedWindowsProcesses(run)
      : () => ownedProcesses(run, uid);
  for (const original of list()) {
    const current = list().find(({ pid }) => pid === original.pid);
    if (!current) continue;
    if (current.identity !== original.identity) {
      warnings.push(`gateway PID ${original.pid}: 소유 재확인 실패`);
      continue;
    }
    const stopped =
      platform === "win32"
        ? tryRun(run, "taskkill", ["/F", "/T", "/PID", original.pid])
        : tryRun(run, "kill", ["-TERM", original.pid]);
    if (!stopped.ok) warnings.push(`gateway PID ${original.pid}: 종료 실패`);
  }
  let remaining;
  for (let attempt = 0; attempt < 10; attempt++) {
    remaining = list();
    if (!remaining.length) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  for (const { pid } of remaining)
    warnings.push(`gateway PID ${pid}: 종료 확인 실패`);
  return false;
}

/** 이전 로컬 MCP 연결을 직접 stdio 연결로 이주한다. */
export function cleanupLegacyMcp({
  home = homedir(),
  repoRoot = process.cwd(),
  platform = osPlatform(),
  run = defaultRun,
  uid = process.getuid?.(),
  env = process.env,
  dryRun = false,
} = {}) {
  const result = {
    ok: true,
    changed: false,
    migrated: 0,
    backups: [],
    warnings: [],
    teardown: { attempted: false, verified: false },
  };
  // 별도 HOME과 테스트에서는 실제 시스템 명령을 실행하지 않는다.
  if (
    run === defaultRun &&
    (process.env.NODE_TEST_CONTEXT || process.env.TRIFLUX_TEST_HOME)
  ) {
    result.skipped = true;
    result.warnings.push("테스트 환경: 주입한 run이 없어 MCP 이주를 건너뜀");
    return result;
  }
  if (
    !dryRun &&
    run === defaultRun &&
    (resolve(home) !== resolve(homedir()) || platform !== osPlatform())
  ) {
    result.ok = false;
    result.warnings.push(
      "격리 실행에는 임시 home, repoRoot와 주입한 run이 필요함",
    );
    return result;
  }
  if (
    resolve(home) !== resolve(homedir()) &&
    resolve(repoRoot) === process.cwd()
  ) {
    result.ok = false;
    result.warnings.push("별도 HOME과 실제 작업 디렉터리가 섞여 이주를 중단함");
    return result;
  }
  const files = [
    [join(home, ".claude.json"), "json"],
    [join(repoRoot, ".mcp.json"), "json"],
    [join(home, ".codex/config.toml"), "toml"],
    [join(home, ".gemini/settings.json"), "json"],
    // agy 는 \${VAR} 참조를 풀지 않으므로 env 없이 바꾸고 셸 환경을 물려받게 한다.
    [join(home, ".gemini/config/mcp_config.json"), "agy"],
  ];
  const plans = [];
  let blocked = false;
  for (const [file, kind] of files) {
    try {
      const target = fileTarget(file);
      if (!target) continue;
      const original = readFileSync(target, "utf8");
      const plan =
        kind === "toml"
          ? patchToml(original, file, home, env, result.warnings)
          : patchJson(original, file, home, env, result.warnings, {
              withEnv: kind !== "agy",
            });
      if (plan.blocked) blocked = true;
      if (plan.count) plans.push({ file, target, original, ...plan });
    } catch {
      result.warnings.push(`${file}: 설정 형식 또는 읽기 실패`);
      blocked = true;
    }
  }
  if (blocked) {
    result.ok = false;
    return result;
  }
  result.migrated = plans.reduce((sum, plan) => sum + plan.count, 0);
  if (dryRun) return result;
  try {
    for (const plan of plans) {
      if (
        fileTarget(plan.file) !== plan.target ||
        readFileSync(plan.target, "utf8") !== plan.original
      )
        throw new Error(`${plan.file}: 검사 후 변경됨`);
      result.backups.push(writeAtomic(plan.file, plan.target, plan.output));
      result.changed = true;
    }
  } catch (error) {
    result.ok = false;
    result.warnings.push(`설정 쓰기 실패: ${error.message}`);
    return result;
  }
  try {
    result.teardown =
      platform === "darwin"
        ? removeDarwin(home, run, result.warnings, uid)
        : platform === "linux"
          ? removeLinux(home, run, result.warnings)
          : platform === "win32"
            ? removeWindows(home, run, result.warnings)
            : { attempted: false, verified: true };
    if (!result.teardown.verified) result.ok = false;
    if (result.teardown.verified) {
      const stopped = stopProcesses(run, result.warnings, platform, uid);
      if (!stopped) result.ok = result.teardown.verified = false;
    }
  } catch (error) {
    result.ok = false;
    result.warnings.push(`시작 등록 해제 실패: ${error.message}`);
  }
  return result;
}

const HUB_SERVER = "tfx-hub";
const HUB_TASK = "TrifluxHubEnsure";
const HUB_CONFIG_FILES = [
  [".claude.json", "json"],
  [".claude/settings.json", "json"],
  [".claude/mcp.json", "json"],
  [".codex/config.json", "json"],
  [".codex/config.toml", "toml"],
  [".gemini/settings.json", "json"],
  [".gemini/config/mcp_config.json", "json"],
];

// 허브가 등록한 항목은 loopback 의 /mcp 주소다. 다른 모양이면 사용자 항목으로 본다.
function isHubEntry(config) {
  if (!config || typeof config !== "object" || Array.isArray(config))
    return false;
  return [config.url, config.httpUrl, config.serverUrl].some((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
        url.pathname === "/mcp"
      );
    } catch {
      return false;
    }
  });
}

function removeHubFromJson(original, file, warnings) {
  const data = JSON.parse(original);
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error(`${file}: JSON 객체가 아닙니다`);
  const groups = [
    data.mcpServers,
    ...Object.values(data.projects ?? {}).map((project) => project?.mcpServers),
  ];
  let count = 0;
  for (const entries of groups) {
    if (
      !entries ||
      typeof entries !== "object" ||
      Array.isArray(entries) ||
      !(HUB_SERVER in entries)
    )
      continue;
    if (!isHubEntry(entries[HUB_SERVER])) {
      warnings.push(`${file}: ${HUB_SERVER} 항목의 소유를 확인할 수 없어 보존`);
      continue;
    }
    delete entries[HUB_SERVER];
    count++;
  }
  return {
    output: count ? `${JSON.stringify(data, null, 2)}\n` : original,
    count,
  };
}

function removeHubFromToml(original, file, warnings) {
  const data = toml.parse(original);
  const entry = data.mcp_servers?.[HUB_SERVER];
  if (!entry) return { output: original, count: 0 };
  if (!isHubEntry(entry)) {
    warnings.push(`${file}: ${HUB_SERVER} 항목의 소유를 확인할 수 없어 보존`);
    return { output: original, count: 0 };
  }
  // [mcp_servers.tfx-hub] 와 그 하위 표만 다음 표 머리글 전까지 걷어낸다.
  const hubHeader = new RegExp(
    `^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:"${HUB_SERVER}"|'${HUB_SERVER}'|${HUB_SERVER})\\s*(?:\\.[^\\]]*)?\\]`,
  );
  let skipping = false;
  const output = original
    .split(/(?<=\n)/)
    .filter((line) => {
      if (/^\s*\[/.test(line)) skipping = hubHeader.test(line);
      return !skipping;
    })
    .join("");
  delete data.mcp_servers[HUB_SERVER];
  if (!Object.keys(data.mcp_servers).length) delete data.mcp_servers;
  try {
    if (!isDeepStrictEqual(toml.parse(output), data))
      throw new Error("TOML 구조 불일치");
  } catch {
    warnings.push(`${file}: 이주 결과 TOML 검증 실패, 파일 보존`);
    return { output: original, count: 0 };
  }
  return { output, count: 1 };
}

function hubCommandLine(pid, platform, run) {
  const result =
    platform === "win32"
      ? runPowerShell(
          run,
          `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
        )
      : tryRun(run, "ps", ["-p", String(pid), "-o", "command="]);
  if (result.ok) return result.output.trim() || null;
  // ps 는 프로세스가 없을 때 status 1 로 끝난다.
  return result.status === 1 ? null : undefined;
}

function stopHub(home, platform, run, result) {
  const pidFile = join(home, ".claude/cache/tfx-hub/hub.pid");
  const target = fileTarget(pidFile);
  if (!target) return;
  let pid;
  try {
    pid = Number(JSON.parse(readFileSync(target, "utf8")).pid);
  } catch {
    /* 아래에서 보존 처리 */
  }
  if (!Number.isInteger(pid) || pid <= 1) {
    result.warnings.push(`${pidFile}: pid 를 읽을 수 없어 보존`);
    return;
  }
  const command = hubCommandLine(pid, platform, run);
  if (command === undefined) {
    result.warnings.push(`${pidFile}: pid ${pid} 확인 실패, 종료하지 않음`);
    return;
  }
  if (command !== null) {
    if (!/[/\\]hub[/\\]server\.mjs(?:["'\s]|$)/.test(command)) {
      result.warnings.push(
        `${pidFile}: pid ${pid} 가 hub/server.mjs 가 아니라 종료하지 않음`,
      );
      return;
    }
    const stopped =
      platform === "win32"
        ? tryRun(run, "taskkill", ["/F", "/T", "/PID", String(pid)])
        : tryRun(run, "kill", ["-TERM", String(pid)]);
    let gone = false;
    for (let attempt = 0; stopped.ok && attempt < 10 && !gone; attempt++) {
      gone = hubCommandLine(pid, platform, run) === null;
      if (!gone)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    if (!gone) {
      result.warnings.push(`${pidFile}: pid ${pid} 종료 확인 실패, 파일 보존`);
      return;
    }
    result.hubStopped = true;
  }
  unlinkSync(target);
  result.changed = true;
}

function removeHubTask(run, result) {
  const query = tryRun(run, "schtasks.exe", [
    "/Query",
    "/TN",
    HUB_TASK,
    "/FO",
    "LIST",
    "/V",
  ]);
  if (!query.ok) return;
  if (!query.output.includes("hub-ensure.mjs")) {
    result.warnings.push(`${HUB_TASK}: hub-ensure 작업이 아니라 보존`);
    return;
  }
  const removed = tryRun(run, "schtasks.exe", [
    "/Delete",
    "/TN",
    HUB_TASK,
    "/F",
  ]);
  if (removed.ok) result.changed = true;
  else result.warnings.push(`${HUB_TASK}: 예약 작업 삭제 실패`);
}

/** 제거된 허브의 설정 항목, 실행 중인 프로세스, 예약 작업, 설치본 스냅샷을 정리한다. */
export function cleanupTfxHub({
  home = homedir(),
  platform = osPlatform(),
  run = defaultRun,
  pluginRoot,
} = {}) {
  const result = {
    ok: true,
    changed: false,
    removed: 0,
    backups: [],
    warnings: [],
    hubStopped: false,
  };
  const injected = run !== defaultRun;
  // 테스트에서는 실제 홈과 시스템 명령을 건드리지 않는다.
  if (
    !injected &&
    (process.env.NODE_TEST_CONTEXT || process.env.TRIFLUX_TEST_HOME)
  ) {
    result.skipped = true;
    return result;
  }
  for (const [relative, kind] of HUB_CONFIG_FILES) {
    const file = join(home, relative);
    try {
      const target = fileTarget(file);
      if (!target) continue;
      const original = readFileSync(target, "utf8");
      const plan =
        kind === "toml"
          ? removeHubFromToml(original, file, result.warnings)
          : removeHubFromJson(original, file, result.warnings);
      if (!plan.count) continue;
      result.backups.push(writeAtomic(file, target, plan.output));
      result.removed += plan.count;
      result.changed = true;
    } catch {
      result.warnings.push(`${file}: 설정 형식 또는 읽기 실패`);
      result.ok = false;
    }
  }
  const realSystem =
    injected ||
    (resolve(home) === resolve(homedir()) && platform === osPlatform());
  if (realSystem) {
    try {
      stopHub(home, platform, run, result);
      if (platform === "win32") removeHubTask(run, result);
    } catch (error) {
      result.ok = false;
      result.warnings.push(`허브 프로세스 정리 실패: ${error.message}`);
    }
  } else {
    result.warnings.push("격리 HOME: 허브 프로세스와 예약 작업 정리는 건너뜀");
  }
  const snapshots = pluginRoot
    ? join(pluginRoot, "references", "gemini-snapshots")
    : null;
  if (snapshots) {
    const entry = lstatSync(snapshots, { throwIfNoEntry: false });
    if (entry?.isDirectory()) {
      rmSync(snapshots, { recursive: true, force: true });
      result.changed = true;
    }
  }
  return result;
}
