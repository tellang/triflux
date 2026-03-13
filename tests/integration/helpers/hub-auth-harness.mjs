// Hub 인증 E2E 테스트 공유 하네스
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const HELPERS_DIR = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(HELPERS_DIR, '..', '..', '..');
export const HUB_SERVER_URL = pathToFileURL(resolve(PROJECT_ROOT, 'hub', 'server.mjs')).href;

export function tempDbPath(rootDir) {
  const dbDir = join(rootDir, '.claude', 'cache', 'tfx-hub');
  mkdirSync(dbDir, { recursive: true });
  return join(dbDir, `hub-auth-${randomUUID()}.db`);
}

export function randomPort() {
  return 28400 + Math.floor(Math.random() * 1000);
}

export function withEnv(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of previous) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

/**
 * Hub 테스트 하네스 생성
 * @param {{ token?: string }} opts
 * @returns {{ homeDir: string, port: number, baseUrl: string, hub: object, cleanup: () => Promise<void>, cleanupAll: () => Promise<void> }}
 */
export async function createHubHarness({ token, homeDir: providedHome } = {}) {
  const homeDir = providedHome || mkdtempSync(join(tmpdir(), 'hub-auth-e2e-'));
  const ownsHome = !providedHome;
  let hub = null;
  let port = 0;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    port = randomPort();
    const dbPath = tempDbPath(homeDir);
    try {
      hub = await withEnv({
        HOME: homeDir,
        USERPROFILE: homeDir,
        TFX_HUB_TOKEN: token ?? null,
      }, async () => {
        const mod = await import(`${HUB_SERVER_URL}?nonce=${Date.now()}-${Math.random()}`);
        return await mod.startHub({ port, dbPath, host: '127.0.0.1', sessionId: `hub-auth-e2e-${randomUUID()}` });
      });
      break;
    } catch (error) {
      if (attempt === 4 || (error?.code !== 'EADDRINUSE' && error?.code !== 'EACCES')) throw error;
    }
  }

  return {
    homeDir,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    hub,
    async cleanup() {
      await withEnv({ HOME: homeDir, USERPROFILE: homeDir }, async () => {
        if (hub?.stop) await hub.stop();
      });
    },
    async cleanupAll() {
      await withEnv({ HOME: homeDir, USERPROFILE: homeDir }, async () => {
        if (hub?.stop) await hub.stop();
      });
      if (ownsHome) {
        try { rmSync(homeDir, { recursive: true, force: true }); } catch {}
      }
    },
  };
}

export function createTeamFixture(homeDir, { teamName, taskId, status = 'pending' }) {
  const teamDir = join(homeDir, '.claude', 'teams', teamName);
  mkdirSync(join(teamDir, 'inboxes'), { recursive: true });
  const tasksDir = join(homeDir, '.claude', 'tasks', teamName);
  mkdirSync(tasksDir, { recursive: true });

  writeFileSync(
    join(teamDir, 'config.json'),
    JSON.stringify({ description: 'hub auth e2e test team' }, null, 2),
    'utf8',
  );

  const taskPath = join(tasksDir, `${taskId}.json`);
  writeFileSync(
    taskPath,
    JSON.stringify({ id: taskId, status, subject: 'Hub auth e2e task', metadata: {} }, null, 2),
    'utf8',
  );

  return taskPath;
}

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export { existsSync, join, rmSync, randomUUID };
