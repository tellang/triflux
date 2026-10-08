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
// 이주가 써 넣는 직접 연결 패키지. 버전은 이 표 한 곳에서만 올린다(2026-10-08 npm 최신, serena 는 v1.7.0 커밋).
export const MCP_PACKAGE_PINS = Object.freeze({
  context7: "@upstash/context7-mcp@4.2.0",
  "brave-search": "@brave/brave-search-mcp-server@2.1.4",
  exa: "exa-mcp-server@3.4.2",
  tavily: "tavily-mcp@0.2.22",
  jira: "mcp-jira-cloud@4.4.0",
  serena:
    "git+https://github.com/oraios/serena@949a27ef1e5fda1a6e7b561e777bcece345c6ffd",
  notion: "@notionhq/notion-mcp-server@2.5.2",
});
// gatewayCmd 는 옛 게이트웨이가 띄운 명령 그대로다. 남은 프로세스를 알아보는 데만 쓴다.
const SERVERS = [
  ["context7", 8100, "npx -y @upstash/context7-mcp@latest", []],
  [
    "brave-search",
    8101,
    "npx -y @brave/brave-search-mcp-server",
    ["BRAVE_API_KEY"],
  ],
  ["exa", 8102, "npx -y exa-mcp-server", ["EXA_API_KEY"]],
  ["tavily", 8103, "npx -y tavily-mcp@latest", ["TAVILY_API_KEY"]],
  [
    "jira",
    8104,
    "npx -y mcp-jira-cloud@latest",
    ["JIRA_API_TOKEN", "JIRA_EMAIL", "JIRA_INSTANCE_URL"],
  ],
  [
    "serena",
    8105,
    "uvx --from git+https://github.com/oraios/serena serena start-mcp-server",
    [],
  ],
  ["notion", 8106, "npx -y @notionhq/notion-mcp-server", ["NOTION_TOKEN"]],
  [
    "notion-guest",
    8107,
    "npx -y @notionhq/notion-mcp-server",
    ["NOTION_TOKEN"],
  ],
].map(([name, port, gatewayCmd, envVars]) => {
  const pin = MCP_PACKAGE_PINS[name === "notion-guest" ? "notion" : name];
  return {
    name,
    port,
    gatewayCmd,
    command: name === "serena" ? "uvx" : "npx",
    args:
      name === "serena"
        ? ["--from", pin, "serena", "start-mcp-server"]
        : ["-y", pin],
    envVars,
  };
});
// 게이트웨이 이주와 허브 정리가 함께 쓰는 사용자 MCP 설정 파일. HOME 기준 경로와 형식.
// ~/.mcp.json 은 HOME 에서 Claude 를 열 때 읽는 파일이라 프로젝트 파일이 아니라 사용자 파일로 본다.
const USER_MCP_FILES = [
  [".claude.json", "json"],
  [".mcp.json", "json"],
  [".claude/mcp.json", "json"],
  [".claude/.mcp.json", "json"],
  [".claude/settings.json", "json"],
  [".codex/config.json", "json"],
  [".codex/config.toml", "toml"],
  [".gemini/settings.json", "json"],
  // agy 는 \${VAR} 참조를 풀지 않으므로 env 없이 바꾸고 셸 환경을 물려받게 한다.
  [".gemini/config/mcp_config.json", "agy"],
];
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

function markFirst(seen, target) {
  const key = realpathSync(target);
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
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

// setup 한 번은 게이트웨이 이주와 허브 정리에 같은 backups 를 넘긴다.
// 같은 파일은 그 setup 에서 처음 바꾸기 직전의 원본만 백업한다.
function writeAtomic(file, target, output, backups = new Map()) {
  const backup = backups.get(target) ?? backupFile(file);
  backups.set(target, backup);
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
      ({ port, gatewayCmd }) =>
        new RegExp(`\\s--port\\s+${port}(?:\\s|$)`).test(command) &&
        command.includes(gatewayCmd),
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
  backups,
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
  const files = USER_MCP_FILES.map(([relative, kind]) => [
    join(home, relative),
    kind,
  ]);
  if (resolve(repoRoot) !== resolve(home))
    files.push([join(repoRoot, ".mcp.json"), "json"]);
  const plans = [];
  const kinds = new Map();
  let blocked = false;
  for (const [file, kind] of files) {
    try {
      const target = fileTarget(file);
      if (!target) continue;
      // symlink 별칭이 같은 파일을 두 번 계획하면 두 번째 쓰기가 원문 검증에서 막힌다.
      // 형식이 다른 별칭(agy 와 json)은 env 처리가 달라 한쪽이 깨지므로 이주를 멈춘다.
      const key = realpathSync(target);
      if (kinds.has(key)) {
        if (kinds.get(key) !== kind) {
          result.warnings.push(
            `${file}: 형식이 다른 설정과 같은 파일이라 이주를 멈춤`,
          );
          blocked = true;
        }
        continue;
      }
      kinds.set(key, kind);
      const original = readFileSync(target, "utf8");
      // 빈 파일은 항목이 없는 것이다. 형식 오류로 보면 이주 전체가 멈춘다.
      if (!original.trim()) continue;
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
      result.backups.push(
        writeAtomic(plan.file, plan.target, plan.output, backups),
      );
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
// [작업 이름, 그 작업이 허브용임을 보여 주는 실행 명령 조각]
// \Triflux\Hub 는 만든 코드가 이력에 없지만 지워진 `tfx hub ensure` 를 실행해 로그온마다 실패한다.
const HUB_TASKS = [
  ["TrifluxHubEnsure", "hub-ensure.mjs"],
  ["\\Triflux\\Hub", "tfx hub ensure"],
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
  const kept = [];
  let skipping = false;
  let trailing = [];
  for (const line of original.split(/(?<=\n)/)) {
    if (/^\s*\[/.test(line)) {
      skipping = hubHeader.test(line);
      if (!skipping) {
        while (trailing[0]?.trim() === "" && kept.at(-1)?.trim() === "")
          trailing.shift();
        kept.push(...trailing);
      }
      trailing = [];
    } else if (skipping) {
      trailing = /^\s*(?:#.*)?\r?\n?$/.test(line) ? [...trailing, line] : [];
      continue;
    }
    if (!skipping) kept.push(line);
  }
  const output = kept.join("");
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
  // ps 는 프로세스가 없을 때 status 1 로 끝난다. PowerShell 실패는 확인 불가다.
  return platform !== "win32" && result.status === 1 ? null : undefined;
}

// 명령줄을 argv 로 나눈다. Linux 는 /proc 의 실제 argv, Windows 는 따옴표 규칙을 쓴다.
// macOS ps 는 인자 경계를 보존하지 않아 공백으로 나누고 exact 를 false 로 둔다.
function processArgv(pid, command, platform) {
  if (platform === "linux") {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (argv.at(-1) === "") argv.pop();
      if (argv.length) return { argv, exact: true };
    } catch {
      // 프로세스가 사라졌거나 /proc 를 읽을 수 없다.
    }
  }
  if (platform === "win32") return splitWindowsCommandLine(command);
  return { argv: command.trim().split(/\s+/), exact: false };
}

// 따옴표 밖 space, tab 에서만 끊고 따옴표 구간은 앞뒤 글자와 한 인자로 잇는다(Windows CRT 규칙).
// 백슬래시로 가린 따옴표는 규칙이 복잡해 경계를 믿지 않는다.
function splitWindowsCommandLine(command) {
  const argv = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (const char of command) {
    if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if ((char === " " || char === "\t") && !quoted) {
      if (started) argv.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) argv.push(current);
  return { argv, exact: !command.includes('\\"') };
}

// 허용 목록. 값을 받는 옵션(다음 인자 또는 --name=value)과 값이 없는 플래그만 건너뛴다.
// 그 밖의 옵션(--run, --eval, --test, --watch 같은 실행 모드 포함)은 entry 를 특정할 수 없어
// 허브가 아닌 것으로 본다.
const NODE_VALUE_OPTIONS = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--env-file",
  "--input-type",
  "-C",
  "--conditions",
]);
const NODE_FLAG_OPTIONS = new Set([
  "--no-warnings",
  "--enable-source-maps",
  "--trace-warnings",
  "--trace-uncaught",
  "--inspect",
  "--expose-gc",
]);

// node 의 entry script 가 triflux 패키지의 hub/server.mjs 일 때만 패키지 루트를 돌려준다.
// 같은 경로를 인자로 받거나 편집하는 다른 프로세스는 허브가 아니다.
// argv 경계를 믿을 수 없으면(exact=false) 값이 붙는 옵션은 공백 든 값일 수 있어 판정하지 않는다.
function trifluxHubRoot({ argv, exact }) {
  if (!/(?:^|[/\\])node(?:\.exe)?$/i.test(argv[0] ?? "")) return null;
  let index = 1;
  while (argv[index]?.startsWith("-")) {
    const [name, value] = argv[index].split("=");
    if (NODE_FLAG_OPTIONS.has(name) && value === undefined) index += 1;
    else if (exact && NODE_VALUE_OPTIONS.has(name))
      index += value === undefined ? 2 : 1;
    else return null;
  }
  // 공백이 든 경로가 잘린 조각은 상대 경로로 남으므로 절대 경로만 받는다.
  const entry = argv[index]?.match(
    /^((?:[A-Za-z]:)?[/\\].*)[/\\]hub[/\\]server\.mjs$/,
  );
  if (!entry) return null;
  // 공백 든 entry 가 잘린 조각일 수 있으므로 뒤에 인자가 남으면 판정하지 않는다.
  if (!exact && argv.length > index + 1) return null;
  try {
    const pkg = JSON.parse(
      readFileSync(join(entry[1], "package.json"), "utf8"),
    );
    return pkg?.name === "triflux" ? entry[1] : null;
  } catch {
    return null;
  }
}

function listHubProcesses(platform, run) {
  if (platform === "win32") {
    const result = runPowerShell(
      run,
      "$items=@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { @{ pid=[string]$_.ProcessId; command=$_.CommandLine } }); ConvertTo-Json -InputObject $items -Compress",
    );
    if (!result.ok) return null;
    return JSON.parse(result.output || "[]");
  }
  const result = tryRun(run, "ps", ["-axo", "pid=,command="]);
  if (!result.ok) return null;
  return result.output.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    return match ? [{ pid: match[1], command: match[2] }] : [];
  });
}

// 허브는 제거됐으므로 triflux 패키지의 hub/server.mjs 로 확인된 프로세스는 설치본,
// 체크아웃, worktree 를 가리지 않고 종료한다(2026-10-08 결정).
function stopHubs(home, platform, run, result, log) {
  const processes = listHubProcesses(platform, run);
  if (!processes) {
    result.warnings.push("허브 프로세스 조회 실패, 종료하지 않음");
    return;
  }
  let allStopped = true;
  for (const { pid, command } of processes) {
    if (Number(pid) === process.pid || typeof command !== "string") continue;
    const root = trifluxHubRoot(processArgv(pid, command, platform));
    if (!root) continue;
    log(`허브 종료: pid ${pid} (${root})`);
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
    if (gone) result.hubStopped = true;
    else {
      allStopped = false;
      result.warnings.push(`허브 pid ${pid}: 종료 확인 실패`);
    }
  }
  const pidFile = join(home, ".claude/cache/tfx-hub/hub.pid");
  if (!allStopped || !fileTarget(pidFile)) return;
  // 판정을 못 했지만 허브로 보이는 프로세스가 hub.pid 에 있으면 단서를 남긴다.
  let pid;
  try {
    pid = Number(JSON.parse(readFileSync(pidFile, "utf8")).pid);
  } catch {
    /* 읽을 수 없는 pid 파일은 지운다 */
  }
  const command = Number.isInteger(pid)
    ? hubCommandLine(pid, platform, run)
    : null;
  if (command && /[/\\]hub[/\\]server\.mjs/.test(command)) {
    result.warnings.push(`${pidFile}: pid ${pid} 를 허브로 확인하지 못해 보존`);
    return;
  }
  unlinkSync(pidFile);
  result.changed = true;
}

// 작업 XML 에서 실행 동작만 꺼낸다. 설명 같은 다른 필드의 문구로 판정하지 않는다.
function taskExecCommand(xml) {
  const decode = (text = "") =>
    text
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  const actions = xml.match(/<Actions\b[^>]*>([\s\S]*?)<\/Actions>/)?.[1] ?? "";
  const execs = [...actions.matchAll(/<Exec\b[^>]*>([\s\S]*?)<\/Exec>/g)];
  if (
    execs.length !== 1 ||
    /<(?:ComHandler|SendEmail|ShowMessage)\b/.test(actions)
  )
    return null;
  const field = (name) =>
    decode(
      execs[0][1].match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1],
    );
  return `${field("Command")} ${field("Arguments")}`;
}

function removeHubTasks(run, result) {
  for (const [task, marker] of HUB_TASKS) {
    const query = tryRun(run, "schtasks.exe", ["/Query", "/TN", task, "/XML"]);
    if (!query.ok) continue;
    if (!taskExecCommand(query.output)?.includes(marker)) {
      result.warnings.push(`${task}: 허브 작업이 아니라 보존`);
      continue;
    }
    const removed = tryRun(run, "schtasks.exe", ["/Delete", "/TN", task, "/F"]);
    if (removed.ok) result.changed = true;
    else result.warnings.push(`${task}: 예약 작업 삭제 실패`);
  }
}

/** cwd 의 프로젝트 MCP 파일 중 제거된 허브가 만든 tfx-hub 항목이 있는 파일을 돌려준다. */
export function findProjectHubEntries(cwd = process.cwd()) {
  return [".mcp.json", ".claude/mcp.json"].flatMap((relative) => {
    const file = join(cwd, relative);
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      return isHubEntry(data?.mcpServers?.[HUB_SERVER]) ? [file] : [];
    } catch {
      return [];
    }
  });
}

/** 제거된 허브의 설정 항목, 실행 중인 프로세스, 예약 작업, 설치본 스냅샷(gemini, codex)을 정리한다. */
export function cleanupTfxHub({
  home = homedir(),
  platform = osPlatform(),
  run = defaultRun,
  pluginRoot,
  log = () => {},
  backups,
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
  const seen = new Set();
  for (const [relative, kind] of USER_MCP_FILES) {
    const file = join(home, relative);
    try {
      const target = fileTarget(file);
      if (!target || !markFirst(seen, target)) continue;
      const original = readFileSync(target, "utf8");
      if (!original.trim()) continue;
      const plan =
        kind === "toml"
          ? removeHubFromToml(original, file, result.warnings)
          : removeHubFromJson(original, file, result.warnings);
      if (!plan.count) continue;
      if (
        fileTarget(file) !== target ||
        readFileSync(target, "utf8") !== original
      ) {
        result.warnings.push(`${file}: 검사 후 변경되어 건너뜀`);
        continue;
      }
      result.backups.push(writeAtomic(file, target, plan.output, backups));
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
      stopHubs(home, platform, run, result, log);
      if (platform === "win32") removeHubTasks(run, result);
    } catch (error) {
      result.ok = false;
      result.warnings.push(`허브 프로세스 정리 실패: ${error.message}`);
    }
  } else {
    result.warnings.push("격리 HOME: 허브 프로세스와 예약 작업 정리는 건너뜀");
  }
  for (const name of pluginRoot
    ? ["gemini-snapshots", "codex-snapshots"]
    : []) {
    const snapshots = join(pluginRoot, "references", name);
    // EBUSY, EPERM, 읽기 전용 설치 디렉터리에서도 setup 이 멈추지 않게 한다.
    try {
      if (lstatSync(snapshots, { throwIfNoEntry: false })?.isDirectory()) {
        rmSync(snapshots, { recursive: true, force: true });
        result.changed = true;
      }
    } catch (error) {
      result.warnings.push(
        `${snapshots}: 삭제 실패 (${error.code ?? error.message})`,
      );
    }
  }
  return result;
}
