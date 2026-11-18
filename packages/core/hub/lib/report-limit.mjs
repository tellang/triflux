export const reportLimit = 4000;
export const headLength = 800;
export const pathLimit = 20;

// /, ./, ~/ 로 시작하는 낱말만 후보로 본다. 버전 문자열(10.82.1/10.82.3)이나 낱말 사이 빗금(Codex/agy)은 여기서 빠진다.
const candidatePattern = /(?<![^\s'"`([<])(?:~\/|\.\/|\/)[^\s'"`<>()[\]{},]+/gu;
// 경로 끝에 붙은 문장부호와 한글 조사는 떼고 판정한다.
const trailing =
  /(?:[.,;:!?)]|을|를|은|는|이|가|에|에서|의|로|으로|와|과|도)+$/u;
const knownDir =
  /(?:^|\/)(?:\.omc|docs|scripts|tests|hud|mods|bin|packages|hub|adapters)(?:\/|$)/;
const extension = /\/[^/]*[^/.]\.[A-Za-z0-9]{1,8}$/;

export function filePaths(text) {
  if (typeof text !== "string" || !text) return [];
  const paths = new Set();
  for (const [candidate] of text.matchAll(candidatePattern)) {
    const path = candidate.replace(trailing, "");
    if (/^[~./\d]+$/.test(path)) continue;
    if (extension.test(path) || knownDir.test(path)) paths.add(path);
  }
  return [...paths];
}

// 리드 규칙상 결과 원문은 파일에 있으므로, 경로가 보일 때만 자른다. 경로가 없으면 원문을 잃으니 자르지 않는다.
// report 는 남길 본문, whole 은 길이를 재고 경로를 찾을 전체 글이다.
export function shorten(report, whole = report) {
  const safeReport = typeof report === "string" ? report : String(report ?? "");
  const safeWhole =
    typeof whole === "string" ? whole : String(whole ?? safeReport);
  if (safeWhole.length <= reportLimit) return { kind: "keep" };
  const paths = filePaths(safeWhole);
  if (!paths.length) return { kind: "warn", total: safeWhole.length };
  const listed = paths.slice(0, pathLimit).map((path) => `- ${path}`);
  if (paths.length > pathLimit) {
    listed.push(`- 외 ${paths.length - pathLimit}개`);
  }
  return {
    kind: "cut",
    text: `${safeReport.slice(0, headLength)}\n\n(중략)\n파일 경로:\n${listed.join("\n")}\n원문 ${safeWhole.length}자, 결과 파일 참조`,
  };
}
