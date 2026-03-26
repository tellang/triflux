// hub/lib/process-utils.mjs
// 프로세스 관련 공유 유틸리티

/**
 * 주어진 PID의 프로세스가 살아있는지 확인한다.
 * EPERM: 프로세스는 존재하지만 signal 권한 없음 → alive
 * ESRCH: 프로세스가 존재하지 않음 → dead
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e?.code === 'EPERM') return true;
    if (e?.code === 'ESRCH') return false;
    return false;
  }
}
