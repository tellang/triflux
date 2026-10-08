// hub/cli-adapter-base.mjs: CLI 실행 명령용 셸 유틸리티

// PowerShell 은 ‘ ’ ‚ ‛ 도 작은따옴표로 읽는다. 따옴표 문자를 모두 겹쳐 써야 인용이 안 끝난다.
export function escapePwshSingleQuoted(value) {
  return String(value).replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&");
}
