#!/usr/bin/env node
// 공개 저장소에 개인 홈 경로, 실제 tailnet 이름, CGNAT(100.64/10) 주소, 알려진 계정명이 들어가지 않게 막는다.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 검사기와 그 테스트는 잡아야 할 형식을 일부러 담는다.
const SKIP = new Set([
  "scripts/lint-private-info.mjs",
  "packages/triflux/scripts/lint-private-info.mjs",
  "tests/unit/lint-private-info.test.mjs",
]);

// 자리표시로 쓰는 사용자명. 여기 없는 이름이 홈 경로에 오면 실제 계정으로 본다.
const PLACEHOLDER_USERS = new Set([
  "example",
  "me",
  "test",
  "user",
  "username",
  "alice",
  "bob",
  "dev",
  "runner",
  "linuxbrew",
  "shared",
  "public",
  "default",
  "foo",
  "remote",
]);
const PLACEHOLDER_TAILNETS = new Set(["example", "tailnet", "your-tailnet"]);

// 계정명 자체를 저장소에 두지 않으려고 sha256 앞 16자리만 둔다.
// 로컬에서 더 막을 이름은 TFX_PRIVATE_TERMS(쉼표 구분)로 넘긴다.
const DENY_HASHES = new Set([
  "daa565e94a765520",
  "d4d27f72e97086f6",
  "75b5dec8aecd72c1",
  "7837a3ae3733ed53",
]);

// 사용자명은 구분자와 인용 경계까지 잡는다. 한글 같은 비ASCII 이름도 빠지지 않게 한다.
// Windows 경로는 대소문자를 가리지 않으므로 i 플래그를 쓴다.
const HOME_PATH =
  /(?:\/Users\/|\/home\/|\b[a-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/))([^\\/\s"'`<>:*?|,;()[\]{}]+)/giu;
const CGNAT = /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g;
const TAILNET = /\b[a-z0-9-]+\.([a-z0-9-]+)\.ts\.net\b/gi;

const hash = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

const extraTerms = new Set(
  String(process.env.TFX_PRIVATE_TERMS || "")
    .split(",")
    .map((term) => term.trim().toLowerCase().replaceAll("_", "-"))
    .filter(Boolean)
    .map(hash),
);

// 하이픈, 밑줄로 이어 붙인 토큰은 연속한 조각 묶음을 모두 비교한다(접두사, 접미사가 붙어도 잡힌다).
function isDenied(token) {
  const parts = token.split(/[-_]/);
  for (let i = 0; i < parts.length; i += 1) {
    for (let j = i + 1; j <= parts.length; j += 1) {
      const digest = hash(parts.slice(i, j).join("-"));
      if (DENY_HASHES.has(digest) || extraTerms.has(digest)) return true;
    }
  }
  return false;
}

// CI 로그도 공개라 찾은 값은 첫 글자만 보인다.
const mask = (value) => `${value[0]}***(${value.length})`;

export function scanText(text) {
  const findings = [];
  text.split("\n").forEach((line, index) => {
    const add = (kind, value) =>
      findings.push({ line: index + 1, kind, value: mask(value) });
    for (let [, user] of line.matchAll(HOME_PATH)) {
      // "/c/Users/x", "/Users/...", "$USER", "%USERNAME%" 같은 자리표시는 넘긴다.
      user = user.replace(/\.+$/u, "");
      if (user.length <= 2 || /^[$%]/u.test(user)) continue;
      if (!PLACEHOLDER_USERS.has(user.toLowerCase())) add("home-path", user);
    }
    for (const [address] of line.matchAll(CGNAT)) {
      if (!address.startsWith("100.64.0.")) add("cgnat-ip", address);
    }
    for (const [, tailnet] of line.matchAll(TAILNET)) {
      if (!PLACEHOLDER_TAILNETS.has(tailnet.toLowerCase()))
        add("tailnet", tailnet);
    }
    for (const token of line.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ||
      []) {
      if (isDenied(token)) add("account", token);
    }
  });
  return findings;
}

function main() {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter((file) => file && !SKIP.has(file) && !file.endsWith(".lock"));
  let count = 0;
  for (const file of files) {
    let buffer;
    try {
      buffer = readFileSync(file);
    } catch {
      continue;
    }
    if (buffer.includes(0)) continue;
    for (const finding of scanText(buffer.toString("utf8"))) {
      count += 1;
      console.error(
        `${file}:${finding.line}: ${finding.kind} ${finding.value}`,
      );
    }
  }
  if (count > 0) {
    console.error(
      `[lint-private] FAIL: ${count}건. 자리표시(example, 192.0.2.x, example.ts.net)로 바꾼다.`,
    );
    process.exit(1);
  }
  console.log(`[lint-private] PASS: ${files.length} file(s) checked.`);
}

// Node 는 메인 모듈 경로의 심볼릭 링크를 푼다. 공백, Windows 표기와 함께 실제 경로로 비교한다.
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
