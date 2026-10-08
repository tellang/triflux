#!/usr/bin/env node

import { argv, exit, stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";

// CTO 기록을 지운 뒤 남은 빈 훅이다. 설치된 hooks.json 이 이 파일을 가리키므로
// 설치기와 사용자 설정 항목을 정리할 때까지 성공 응답만 돌려준다.
export async function runAgySessionHook(_stdinData, opts = {}) {
  const output = "{}\n";
  if (opts.writeStdout !== false) stdout.write(output);
  return output;
}

function drainStdin() {
  return new Promise((resolve) => {
    stdin.on("data", () => {});
    stdin.on("end", resolve);
    stdin.on("error", resolve);
  });
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  await drainStdin();
  await runAgySessionHook("");
  exit(0);
}
