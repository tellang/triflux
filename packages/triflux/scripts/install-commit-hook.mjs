#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// prepare는 npm pack/publish와 git 의존성 설치에서도 실행된다.
// 현재 패키지가 저장소 루트 체크아웃일 때만 로컬 Git 설정을 바꾼다.
if (!existsSync(resolve(packageRoot, ".git"))) process.exit(0);

try {
  const git = (...args) =>
    execFileSync("git", ["-C", packageRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  if (
    realpathSync(git("rev-parse", "--show-toplevel")) !==
    realpathSync(packageRoot)
  ) {
    process.exit(0);
  }
  const current = git("config", "--get", "core.hooksPath");
  if (current) {
    if (current !== ".githooks") {
      console.warn(
        `triflux prepare: 기존 core.hooksPath(${current})를 유지합니다.`,
      );
    }
    process.exit(0);
  }
} catch (error) {
  // --get의 종료 코드 1은 설정이 없는 정상 상태다.
  if (error.status !== 1) {
    console.warn(
      `triflux prepare: Git hook 설정을 건너뜁니다: ${error.message}`,
    );
    process.exit(0);
  }
}

try {
  execFileSync(
    "git",
    ["-C", packageRoot, "config", "--local", "core.hooksPath", ".githooks"],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
} catch (error) {
  console.warn(
    `triflux prepare: Git hook 설정에 실패했습니다: ${error.message}`,
  );
}
