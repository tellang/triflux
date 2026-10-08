// 프롬프트를 argv 로 넘기면 ps 에 보이므로 stdin 리다이렉트용 파일로 넘긴다.
// 파일은 매번 새 이름이고 정리는 OS 임시 디렉터리 정리에 맡긴다.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { privateTmpDir } from "./private-tmp.mjs";

let counter = 0;

export function writePromptToTmpFile(prompt) {
  const id = `${Date.now()}-${process.pid}-${counter++}`;
  const file = join(privateTmpDir("triflux-codex-prompt"), `prompt-${id}.txt`);
  writeFileSync(file, String(prompt ?? ""), { encoding: "utf8", mode: 0o600 });
  return file;
}
