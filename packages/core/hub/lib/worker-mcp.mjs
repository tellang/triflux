import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mcpEndpointId,
  readMcpCatalog,
} from "../../scripts/lib/mcp-recommendation-catalog.mjs";
import { mcpDefinitionIdentity } from "./mcp-recommendations.mjs";
import { privateTmpDir } from "./private-tmp.mjs";

export const WORKER_MCP_LAUNCHER = fileURLToPath(import.meta.url);

const toml = createRequire(import.meta.url)("@iarna/toml");
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);

// 원 정의는 이 함수 안에서만 읽는다. 프롬프트와 결과에는 이름과 고정 상태만 남긴다.
export function prepareWorkerMcp(input, options = {}) {
  const env = options.env || process.env;
  const home = env.HOME || homedir();
  const cwd = resolve(input.cwd || process.cwd());
  const cli = input.cli === "antigravity" ? "agy" : input.cli;
  const metadata = {
    cli,
    status: "deferred",
    reasons: [],
    servers: [],
    applied: false,
    appliedTo: null,
    runtimeConfirmed: false,
    toolVerified: false,
  };
  const result = {
    metadata,
    codexConfigOverrides: input.policy?.codexConfigOverrides || [],
    configFile: null,
    cleanup() {},
  };
  const defer = (reason) => {
    metadata.reasons.push(reason);
    return result;
  };
  try {
    if (cli === "agy") return defer("agy_server_session_isolation_unverified");
    if (cli === "claude-native") return defer("native_metadata_only");
    if (!["codex", "claude"].includes(cli)) return defer("cli_unsupported");
    if (input.explicitConfig) return defer("explicit_mcp_config");
    if (!input.profileWasAuto) return defer("explicit_mcp_profile");
    if (input.explicitFilters) return defer("explicit_mcp_filters");
    if (cli === "codex" && input.transport !== "exec")
      return defer("codex_transport_isolation_unverified");
    if (input.recommendation?.status !== "recommended")
      return defer("no_recommendation");
    const recommendations = input.recommendation.recommendations;
    if (!Array.isArray(recommendations) || recommendations.length !== 1)
      return defer("recommendation_ambiguous");
    const entries = readMcpCatalog({ ...options, env }).entries.filter(
      (entry) =>
        entry.id === recommendations[0].id && entry.targets.includes(cli),
    );
    if (entries.length !== 1) return defer("catalog_identity_unavailable");
    try {
      readFileSync(join(home, ".claude", "cache", "mcp-enabled.json"), "utf8");
      return defer("explicit_mcp_manifest");
    } catch (error) {
      if (error.code !== "ENOENT")
        return defer("registration_config_unreadable");
    }
    const identity = entries[0].identity;
    const registrations = [];
    const configs = [];
    let invalid = false;
    const seenFiles = new Set();
    function read(file, scope, format = "json") {
      try {
        const canonical = realpathSync(file);
        if (seenFiles.has(canonical)) return {};
        seenFiles.add(canonical);
        const raw = readFileSync(file, "utf8");
        const config = format === "toml" ? toml.parse(raw) : JSON.parse(raw);
        if (!object(config)) {
          invalid = true;
          return {};
        }
        configs.push({ config, scope });
        const groups = [
          cli === "codex" ? config.mcp_servers : config.mcpServers,
        ];
        if (cli === "claude") groups.push(config.projects?.[cwd]?.mcpServers);
        for (const [index, group] of groups.entries()) {
          if (group === undefined) continue;
          if (!object(group)) {
            invalid = true;
            continue;
          }
          for (const [name, definition] of Object.entries(group)) {
            if (!object(definition)) {
              invalid = true;
              continue;
            }
            registrations.push({
              name,
              definition,
              scope: index === 1 ? "project-local" : scope,
              identity: mcpDefinitionIdentity(definition),
            });
          }
        }
        return config;
      } catch (error) {
        if (error.code !== "ENOENT") invalid = true;
        return {};
      }
    }
    let user;
    if (cli === "codex") {
      const file =
        env.TFX_CODEX_CONFIG ||
        join(
          env.CODEX_HOME || env.TFX_CODEX_HOME || join(home, ".codex"),
          "config.toml",
        );
      user = read(file, "user", "toml");
      if (resolve(file) !== join(cwd, ".codex", "config.toml"))
        read(join(cwd, ".codex", "config.toml"), "project", "toml");
    } else {
      user = read(join(home, ".claude.json"), "user");
      read(join(home, ".claude", "settings.json"), "user");
      read(join(home, ".claude", "settings.local.json"), "user");
      read(join(cwd, ".claude", "mcp.json"), "project");
      read(join(cwd, ".mcp.json"), "project");
      read(join(cwd, ".claude", "settings.json"), "project");
      read(join(cwd, ".claude", "settings.local.json"), "local");
    }
    if (invalid) return defer("registration_config_unreadable");
    const matches = registrations.filter(
      (entry) =>
        entry.identity.endpoints.some((id) =>
          identity.endpoints.includes(id),
        ) ||
        identity.packages.some((pkg) =>
          entry.identity.packages.includes(
            mcpEndpointId(`https://package.invalid/${pkg}`),
          ),
        ),
    );
    if (!matches.length) return defer("local_registration_missing");
    if (matches.length !== 1) return defer("registration_ambiguous");
    const selected = matches[0];
    if (
      registrations.filter((entry) => entry.name === selected.name).length !== 1
    )
      return defer("registration_ambiguous");
    if (/[\x00-\x1f\x7f]/.test(selected.name))
      return defer("registration_name_invalid");
    const def = selected.definition;
    const rejected = configs.some(({ config }) =>
      [config, config.projects?.[cwd]].some((settings) =>
        ["disabledMcpServers", "disabledMcpjsonServers"].some((key) =>
          settings?.[key]?.includes(selected.name),
        ),
      ),
    );
    if (def.enabled === false || def.disabled === true || rejected)
      return defer("registration_disabled");
    if (selected.scope.startsWith("project")) {
      const trusted =
        cli === "codex"
          ? user.projects?.[cwd]?.trust_level === "trusted"
          : user.projects?.[cwd]?.hasTrustDialogAccepted === true;
      const approved =
        cli === "codex" ||
        selected.scope === "project-local" ||
        configs.some(
          ({ config, scope }) =>
            scope !== "project" &&
            [config, config.projects?.[cwd]].some(
              (settings) =>
                settings?.enableAllProjectMcpServers === true ||
                settings?.enabledMcpjsonServers?.includes(selected.name) ||
                settings?.enabledMcpServers?.includes(selected.name),
            ),
        );
      if (!trusted || !approved) return defer("project_approval_unverified");
    }
    if (
      !(typeof def.command === "string" && def.command) &&
      !(typeof def.url === "string" && def.url)
    )
      return defer("registration_transport_unverified");
    metadata.servers = [selected.name];
    if (cli === "codex") {
      // 기존 도구 목록과 승인 키는 덮어쓰지 않고 서버 선택만 바꾼다.
      const flags = [];
      for (const name of new Set(
        registrations
          .filter(
            (entry) =>
              typeof entry.definition.command === "string" ||
              typeof entry.definition.url === "string",
          )
          .filter(
            (entry) =>
              entry.scope !== "project" ||
              user.projects?.[cwd]?.trust_level === "trusted",
          )
          .map((entry) => entry.name),
      )) {
        const key = /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
        flags.push(`mcp_servers.${key}.enabled=${name === selected.name}`);
      }
      const prefix = `mcp_servers.${/^[A-Za-z0-9_-]+$/.test(selected.name) ? selected.name : JSON.stringify(selected.name)}.`;
      const toolOverride = result.codexConfigOverrides.find((flag) =>
        flag.startsWith(`${prefix}enabled_tools=`),
      );
      if (toolOverride) {
        const tools = JSON.parse(
          toolOverride.slice(`${prefix}enabled_tools=`.length),
        );
        const narrowed = tools.filter(
          (tool) =>
            (!Array.isArray(def.enabled_tools) ||
              def.enabled_tools.includes(tool)) &&
            !def.disabled_tools?.includes(tool),
        );
        flags.push(`${prefix}enabled_tools=${JSON.stringify(narrowed)}`);
      }
      result.codexConfigOverrides = flags;
    } else {
      const dir = mkdtempSync(
        join(privateTmpDir("worker-mcp", { base: env.TMPDIR }), "run-"),
      );
      result.configFile = join(dir, "mcp.json");
      result.cleanup = () => {
        try {
          unlinkSync(result.configFile);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        try {
          rmdirSync(dir);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      };
      try {
        writeFileSync(
          result.configFile,
          JSON.stringify({ mcpServers: { [selected.name]: def } }),
          { mode: 0o600, flag: "wx" },
        );
      } catch {
        result.cleanup();
        result.configFile = null;
        metadata.servers = [];
        return defer("private_config_write_failed");
      }
    }
    metadata.status = "prepared";
    return result;
  } catch {
    result.cleanup();
    result.configFile = null;
    metadata.servers = [];
    metadata.status = "deferred";
    return defer("mcp_application_unavailable");
  }
}

// Claude direct backend용 실행 래퍼. 비밀 정의는 argv나 stdin으로 전달하지 않는다.
async function launchClaude(argv) {
  const [requestFile, metadataFile, ...command] = argv;
  const input = JSON.parse(readFileSync(requestFile, "utf8"));
  const plan = prepareWorkerMcp(input);
  const args = command.slice(1);
  if (plan.configFile)
    args.push("--mcp-config", plan.configFile, "--strict-mcp-config");
  let child;
  let killTimer;
  const forward = (signal) => {
    child?.kill(signal);
    killTimer ||= setTimeout(() => child?.kill("SIGKILL"), 1000);
    killTimer.unref();
  };
  const onTerm = () => forward("SIGTERM");
  const onInt = () => forward("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  try {
    writeFileSync(
      metadataFile,
      JSON.stringify({
        recommendation: input.recommendation,
        application: plan.metadata,
      }),
      { mode: 0o600 },
    );
    child = spawn(command[0], args, { stdio: "inherit" });
    child.once("spawn", () => {
      if (plan.metadata.status === "prepared") {
        plan.metadata.status = "configured";
        plan.metadata.appliedTo = "start_args";
        writeFileSync(
          metadataFile,
          JSON.stringify({
            recommendation: input.recommendation,
            application: plan.metadata,
          }),
          { mode: 0o600 },
        );
      }
    });
    const code = await new Promise((done) => {
      child.once("error", () => done(127));
      child.once("exit", (status, signal) =>
        done(status ?? (signal === "SIGINT" ? 130 : 143)),
      );
    });
    process.exitCode = code;
  } finally {
    clearTimeout(killTimer);
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
    plan.cleanup();
    unlinkSync(requestFile);
  }
}

if (process.argv[1] && WORKER_MCP_LAUNCHER === process.argv[1]) {
  await launchClaude(process.argv.slice(2));
}
