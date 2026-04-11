// scripts/lib/process-utils.mjs
// 프로세스 관련 공유 유틸리티 (훅 및 lightweight 스크립트용)
//
// Note: hub/lib/process-utils.mjs에는 더 포괄적인 orphan cleanup 로직이 있습니다.
// 이 파일은 단순 alive 체크만 필요한 훅/스크립트용 (상위 의존성 없이 동작).

/**
 * 주어진 PID의 프로세스가 살아있는지 확인합니다.
 * - EPERM: 프로세스는 존재하지만 signal 권한 없음 → alive
 * - ESRCH: 프로세스가 존재하지 않음 → dead
 * - 기타 에러 (invalid pid 포함): dead로 간주
 *
 * @param {number|string} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    if (e?.code === "EPERM") return true;
    return false;
  }
}
