// hub/paths.mjs — triflux 워킹 디렉토리 경로 상수

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const TFX_WORK_DIR = '.tfx';
export const TFX_PLANS_DIR = join(TFX_WORK_DIR, 'plans');
export const TFX_REPORTS_DIR = join(TFX_WORK_DIR, 'reports');
export const TFX_HANDOFFS_DIR = join(TFX_WORK_DIR, 'handoffs');
export const TFX_LOGS_DIR = join(TFX_WORK_DIR, 'logs');
export const TFX_STATE_DIR = join(TFX_WORK_DIR, 'state');
export const TFX_FULLCYCLE_DIR = join(TFX_WORK_DIR, 'fullcycle');

/**
 * triflux 워킹 디렉토리 구조를 보장한다.
 * @param {string} baseDir
 */
export function ensureTfxDirs(baseDir) {
  for (const relativeDir of [
    TFX_WORK_DIR,
    TFX_PLANS_DIR,
    TFX_REPORTS_DIR,
    TFX_HANDOFFS_DIR,
    TFX_LOGS_DIR,
    TFX_STATE_DIR,
    TFX_FULLCYCLE_DIR,
  ]) {
    mkdirSync(join(baseDir, relativeDir), { recursive: true });
  }
}
