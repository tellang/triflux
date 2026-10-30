import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const MAX_FILE_BYTES = 64 * 1024;

function readConfigFile(path, privateFile = false) {
  let fd;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW || 0) |
        (constants.O_NONBLOCK || 0),
    );
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    if (typeof process.getuid !== "function" || stat.uid !== process.getuid())
      return null;
    if (
      privateFile ? (stat.mode & 0o7777) !== 0o600 : (stat.mode & 0o022) !== 0
    )
      return null;
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    return size <= MAX_FILE_BYTES ? buffer.toString("utf8", 0, size) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readJevHostConfig(env = process.env) {
  // 명시 env fixture는 주입한 HOME/XDG만 사용한다. 빈 객체는 실제 홈을 읽지 않는다.
  const configHome =
    env.XDG_CONFIG_HOME ||
    (env.HOME
      ? join(env.HOME, ".config")
      : env === process.env
        ? join(homedir(), ".config")
        : null);
  if (!configHome || !isAbsolute(configHome)) return null;
  try {
    const config = JSON.parse(
      readConfigFile(join(configHome, "triflux", "jev.json")),
    );
    return config?.enabled === true ? config : null;
  } catch {
    return null;
  }
}

export function readJevHostApiKey(env = process.env) {
  const config = readJevHostConfig(env);
  if (typeof config?.apiKeyFile !== "string" || !isAbsolute(config.apiKeyFile))
    return null;
  const text = readConfigFile(config.apiKeyFile, true);
  if (text == null) return null;
  const keys = {};
  for (const line of text.split(/\r?\n/)) {
    const assignment = line.match(
      /^\s*(?:export\s+)?(JEV_API_KEY|TYPESAFE_API_KEY)\s*=(.*)$/,
    );
    if (!assignment) continue;
    const [, name, raw] = assignment;
    const literal = raw
      .trim()
      .match(/^(?:'([^']*)'|"([^"]*)"|([^\s'";#]+))\s*(?:#.*)?$/);
    if (!literal || name in keys) return null;
    const value = (literal[1] ?? literal[2] ?? literal[3]).trim();
    if (!value || /[$`\\\x00-\x1f\x7f]/.test(value)) return null;
    keys[name] = value;
  }
  return keys.JEV_API_KEY || keys.TYPESAFE_API_KEY || null;
}
