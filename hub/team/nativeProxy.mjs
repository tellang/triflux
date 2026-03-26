// hub/team/nativeProxy.mjs
// Claude Native Teams 파일을 Hub tool/REST에서 안전하게 읽고 쓰기 위한 유틸.

import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  open as openFile,
  readdir,
  readFile,
  stat,
  unlink as unlinkFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { isPidAlive } from '../lib/process-utils.mjs';

const TEAM_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const CLAUDE_HOME = join(homedir(), '.claude');
const TEAMS_ROOT = join(CLAUDE_HOME, 'teams');
const TASKS_ROOT = join(CLAUDE_HOME, 'tasks');
const LOCK_STALE_MS = 30000;

// ── 인메모리 캐시 (디렉토리 mtime 기반 무효화) ──
const _dirCache = new Map(); // tasksDir → { mtimeMs, files: string[] }
const _taskIdIndex = new Map(); // taskId → filePath
const _taskContentCache = new Map(); // filePath → { mtimeMs, data }

function _invalidateCache(tasksDir) {
  _dirCache.delete(tasksDir);
}

function err(code, message, extra = {}) {
  return { ok: false, error: { code, message, ...extra } };
}

function validateTeamName(teamName) {
  if (!TEAM_NAME_RE.test(String(teamName || ''))) {
    throw new Error('INVALID_TEAM_NAME');
  }
}

async function readJsonSafe(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    renameSync(tmp, path);
  } catch (e) {
    // Windows NTFS: 대상 파일 존재 시 rename 실패 가능 → 삭제 후 재시도
    if (process.platform === 'win32' && (e.code === 'EPERM' || e.code === 'EEXIST')) {
      try { unlinkSync(path); } catch {}
      renameSync(tmp, path);
    } else {
      try { unlinkSync(tmp); } catch {}
      throw e;
    }
  }
}

async function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readLockInfo(lockPath) {
  let lockStat;
  try {
    lockStat = await stat(lockPath);
  } catch {
    return null;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {}

  const now = Date.now();
  const createdAtMs = Number(
    parsed?.created_at_ms
    ?? parsed?.timestamp_ms
    ?? parsed?.timestamp
    ?? lockStat.mtimeMs,
  );
  const pid = Number(parsed?.pid);

  return {
    token: typeof parsed?.token === 'string' ? parsed.token : null,
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    created_at_ms: Number.isFinite(createdAtMs) ? createdAtMs : lockStat.mtimeMs,
    mtime_ms: lockStat.mtimeMs,
    age_ms: Math.max(0, now - (Number.isFinite(createdAtMs) ? createdAtMs : lockStat.mtimeMs)),
  };
}

async function releaseFileLock(lockPath, token, handle) {
  try { await handle?.close(); } catch {}

  try {
    const current = await readLockInfo(lockPath);
    if (!current || current.token === token) {
      await unlinkFile(lockPath);
    }
  } catch {}
}

async function withFileLock(lockPath, fn, retries = 20, delayMs = 25, staleMs = LOCK_STALE_MS) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const lockOwner = {
    pid: process.pid,
    token: randomUUID(),
    created_at: new Date().toISOString(),
    created_at_ms: Date.now(),
  };
  let handle = null;
  let lastError = null;

  for (let i = 0; i < retries; i += 1) {
    try {
      handle = await openFile(lockPath, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify(lockOwner)}\n`, 'utf8');
      } catch (writeError) {
        await releaseFileLock(lockPath, lockOwner.token, handle);
        throw writeError;
      }
      break;
    } catch (e) {
      lastError = e;
      if (e?.code !== 'EEXIST') throw e;

      const current = await readLockInfo(lockPath);
      const staleByAge = !current || current.age_ms > staleMs;
      const staleByDeadPid = current?.pid != null && !isPidAlive(current.pid);
      if (staleByAge || staleByDeadPid) {
        try {
          await unlinkFile(lockPath);
          continue;
        } catch (unlinkError) {
          if (unlinkError?.code === 'ENOENT') continue;
          lastError = unlinkError;
        }
      }

      if (i === retries - 1) throw e;
      await sleepMs(delayMs);
    }
  }

  if (!handle) {
    throw lastError || new Error(`LOCK_NOT_ACQUIRED: ${lockPath}`);
  }

  try {
    return await fn();
  } finally {
    await releaseFileLock(lockPath, lockOwner.token, handle);
  }
}

function getLeadSessionId(config) {
  return config?.leadSessionId
    || config?.lead_session_id
    || config?.lead?.lead_session_id
    || config?.lead?.sessionId
    || null;
}

export async function resolveTeamPaths(teamName) {
  validateTeamName(teamName);

  const teamDir = join(TEAMS_ROOT, teamName);
  const configPath = join(teamDir, 'config.json');
  const inboxesDir = join(teamDir, 'inboxes');
  const config = await readJsonSafe(configPath);
  const leadSessionId = getLeadSessionId(config);

  const byTeam = join(TASKS_ROOT, teamName);
  const byLeadSession = leadSessionId ? join(TASKS_ROOT, leadSessionId) : null;

  let tasksDir = byTeam;
  let tasksDirResolution = 'not_found';
  if (existsSync(byTeam)) {
    tasksDirResolution = 'team_name';
  } else if (byLeadSession && existsSync(byLeadSession)) {
    tasksDir = byLeadSession;
    tasksDirResolution = 'lead_session_id';
  }

  return {
    team_dir: teamDir,
    config_path: configPath,
    inboxes_dir: inboxesDir,
    tasks_dir: tasksDir,
    tasks_dir_resolution: tasksDirResolution,
    lead_session_id: leadSessionId,
    config,
  };
}

export async function forceCleanupTeam(teamName) {
  validateTeamName(teamName);

  let paths;
  try {
    paths = await resolveTeamPaths(teamName);
  } catch {
    paths = {
      team_dir: join(TEAMS_ROOT, teamName),
      config_path: join(TEAMS_ROOT, teamName, 'config.json'),
      tasks_dir: join(TASKS_ROOT, teamName),
      lead_session_id: null,
      config: null,
    };
  }

  try {
    const config = paths.config || await readJsonSafe(paths.config_path);
    if (config && Array.isArray(config.members)) {
      atomicWriteJson(paths.config_path, {
        ...config,
        members: config.members.map((member) => ({ ...member, isActive: false })),
      });
    }
  } catch {}

  const cleanupTargets = new Set([
    paths.team_dir,
    join(TASKS_ROOT, teamName),
    paths.tasks_dir,
  ]);
  if (paths.lead_session_id) {
    cleanupTargets.add(join(TASKS_ROOT, paths.lead_session_id));
  }

  for (const targetPath of cleanupTargets) {
    if (!targetPath) continue;
    try {
      rmSync(targetPath, { recursive: true, force: true });
    } catch {}
  }
}

async function collectTaskFiles(tasksDir) {
  if (!existsSync(tasksDir)) return [];

  // 디렉토리 mtime 기반 캐시 — O(N) I/O를 반복 호출 시 O(1)로 축소
  let dirMtime;
  try { dirMtime = (await stat(tasksDir)).mtimeMs; } catch { return []; }

  const cached = _dirCache.get(tasksDir);
  if (cached && cached.mtimeMs === dirMtime) {
    return cached.files;
  }

  const entries = await readdir(tasksDir);
  const files = entries
    .filter((name) => name.endsWith('.json'))
    .filter((name) => !name.endsWith('.lock'))
    .filter((name) => name !== '.highwatermark')
    .map((name) => join(tasksDir, name));

  _dirCache.set(tasksDir, { mtimeMs: dirMtime, files });
  return files;
}

async function readTaskFileCached(file) {
  let fileMtime;
  try {
    fileMtime = (await stat(file)).mtimeMs;
  } catch {
    return { file, mtimeMs: null, json: null };
  }

  const contentCached = _taskContentCache.get(file);
  if (contentCached && contentCached.mtimeMs === fileMtime) {
    return { file, mtimeMs: fileMtime, json: contentCached.data };
  }

  const json = await readJsonSafe(file);
  if (json && isObject(json)) {
    _taskContentCache.set(file, { mtimeMs: fileMtime, data: json });
  }

  return { file, mtimeMs: fileMtime, json };
}

async function locateTaskFile(tasksDir, taskId) {
  const direct = join(tasksDir, `${taskId}.json`);
  if (existsSync(direct)) return direct;

  // ID→파일 인덱스 캐시
  const indexed = _taskIdIndex.get(taskId);
  if (indexed && existsSync(indexed)) return indexed;

  // 캐시된 collectTaskFiles로 풀 스캔
  const files = await collectTaskFiles(tasksDir);
  for (const file of files) {
    if (basename(file, '.json') === taskId) {
      _taskIdIndex.set(taskId, file);
      return file;
    }
    const json = await readJsonSafe(file);
    if (json && String(json.id || '') === taskId) {
      _taskIdIndex.set(taskId, file);
      return file;
    }
  }
  return null;
}

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export async function teamInfo(args = {}) {
  const { team_name, include_members = true, include_paths = true } = args;
  try {
    validateTeamName(team_name);
  } catch {
    return err('INVALID_TEAM_NAME', 'team_name 형식이 올바르지 않습니다');
  }

  const paths = await resolveTeamPaths(team_name);
  if (!existsSync(paths.team_dir)) {
    return err('TEAM_NOT_FOUND', `팀 디렉토리가 없습니다: ${paths.team_dir}`);
  }

  const members = Array.isArray(paths.config?.members) ? paths.config.members : [];
  const leadAgentId = paths.config?.leadAgentId
    || paths.config?.lead_agent_id
    || members[0]?.agentId
    || null;

  return {
    ok: true,
    data: {
      team: {
        team_name,
        description: paths.config?.description || null,
      },
      lead: {
        lead_agent_id: leadAgentId,
        lead_session_id: paths.lead_session_id,
      },
      ...(include_members ? { members } : {}),
      ...(include_paths ? {
        paths: {
          config_path: paths.config_path,
          tasks_dir: paths.tasks_dir,
          inboxes_dir: paths.inboxes_dir,
          tasks_dir_resolution: paths.tasks_dir_resolution,
        },
      } : {}),
    },
  };
}

export async function teamTaskList(args = {}) {
  const {
    team_name,
    owner,
    statuses = [],
    include_internal = false,
    limit = 200,
  } = args;

  try {
    validateTeamName(team_name);
  } catch {
    return err('INVALID_TEAM_NAME', 'team_name 형식이 올바르지 않습니다');
  }

  const paths = await resolveTeamPaths(team_name);
  if (paths.tasks_dir_resolution === 'not_found') {
    return err('TASKS_DIR_NOT_FOUND', `task 디렉토리를 찾지 못했습니다: ${team_name}`);
  }

  const statusSet = new Set((statuses || []).map((s) => String(s)));
  const maxCount = Math.max(1, Math.min(Number(limit) || 200, 1000));
  let parseWarnings = 0;
  const files = await collectTaskFiles(paths.tasks_dir);
  const records = await Promise.all(files.map((file) => readTaskFileCached(file)));

  const tasks = [];
  for (const { file, mtimeMs: fileMtime, json } of records) {
    if (!json || !isObject(json)) {
      parseWarnings += 1;
      continue;
    }

    if (!include_internal && json?.metadata?._internal === true) continue;
    if (owner && String(json.owner || '') !== String(owner)) continue;
    if (statusSet.size > 0 && !statusSet.has(String(json.status || ''))) continue;

    tasks.push({
      ...json,
      task_file: file,
      mtime_ms: fileMtime,
    });
  }

  tasks.sort((a, b) => Number(b.mtime_ms || 0) - Number(a.mtime_ms || 0));
  const sliced = tasks.slice(0, maxCount);

  return {
    ok: true,
    data: {
      tasks: sliced,
      count: sliced.length,
      parse_warnings: parseWarnings,
      tasks_dir: paths.tasks_dir,
      tasks_dir_resolution: paths.tasks_dir_resolution,
    },
  };
}

// status 화이트리스트 (Claude Code API 호환)
const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed', 'deleted']);

export async function teamTaskUpdate(args = {}) {
  // "failed" → "completed" + metadata.result 자동 매핑
  if (String(args.status || '') === 'failed') {
    args = {
      ...args,
      status: 'completed',
      metadata_patch: { ...(args.metadata_patch || {}), result: 'failed' },
    };
  } else if (args.status != null && !VALID_STATUSES.has(String(args.status))) {
    return err('INVALID_STATUS', `유효하지 않은 status: ${args.status}. 허용: ${[...VALID_STATUSES].join(', ')}`);
  }

  const {
    team_name,
    task_id,
    claim = false,
    owner,
    status,
    subject,
    description,
    activeForm,
    add_blocks = [],
    add_blocked_by = [],
    metadata_patch,
    if_match_mtime_ms,
    actor,
  } = args;

  try {
    validateTeamName(team_name);
  } catch {
    return err('INVALID_TEAM_NAME', 'team_name 형식이 올바르지 않습니다');
  }

  if (!String(task_id || '').trim()) {
    return err('INVALID_TASK_ID', 'task_id가 필요합니다');
  }

  const paths = await resolveTeamPaths(team_name);
  if (paths.tasks_dir_resolution === 'not_found') {
    return err('TASKS_DIR_NOT_FOUND', `task 디렉토리를 찾지 못했습니다: ${team_name}`);
  }

  const taskFile = await locateTaskFile(paths.tasks_dir, String(task_id));
  if (!taskFile) {
    return err('TASK_NOT_FOUND', `task를 찾지 못했습니다: ${task_id}`);
  }

  const lockFile = `${taskFile}.lock`;

  try {
    return await withFileLock(lockFile, async () => {
      const before = await readJsonSafe(taskFile);
      if (!before || !isObject(before)) {
        return err('INVALID_TASK_FILE', `task 파일 파싱 실패: ${taskFile}`);
      }

      let beforeMtime = Date.now();
      try { beforeMtime = (await stat(taskFile)).mtimeMs; } catch {}

      if (if_match_mtime_ms != null && Number(if_match_mtime_ms) !== Number(beforeMtime)) {
        return err('MTIME_CONFLICT', 'if_match_mtime_ms가 일치하지 않습니다', {
          task_file: taskFile,
          mtime_ms: beforeMtime,
        });
      }

      const after = JSON.parse(JSON.stringify(before));
      let claimed = false;
      let updated = false;

      if (claim) {
        const requestedOwner = String(owner || actor || '');
        const ownerNow = String(before.owner || '');
        const ownerCompatible = ownerNow === '' || requestedOwner === '' || ownerNow === requestedOwner;
        const statusPending = String(before.status || '') === 'pending';

        if (!statusPending || !ownerCompatible) {
          return err('CLAIM_CONFLICT', 'task claim 충돌', {
            task_before: before,
            task_file: taskFile,
            mtime_ms: beforeMtime,
          });
        }

        if (requestedOwner) after.owner = requestedOwner;
        after.status = status || 'in_progress';
        claimed = true;
        updated = true;
      }

      if (owner != null && String(after.owner || '') !== String(owner)) {
        after.owner = owner;
        updated = true;
      }
      if (status != null && String(after.status || '') !== String(status)) {
        after.status = status;
        updated = true;
      }
      if (subject != null && String(after.subject || '') !== String(subject)) {
        after.subject = subject;
        updated = true;
      }
      if (description != null && String(after.description || '') !== String(description)) {
        after.description = description;
        updated = true;
      }
      if (activeForm != null && String(after.activeForm || '') !== String(activeForm)) {
        after.activeForm = activeForm;
        updated = true;
      }

      if (Array.isArray(add_blocks) && add_blocks.length > 0) {
        const current = Array.isArray(after.blocks) ? [...after.blocks] : [];
        for (const item of add_blocks) {
          if (!current.includes(item)) current.push(item);
        }
        after.blocks = current;
        updated = true;
      }

      if (Array.isArray(add_blocked_by) && add_blocked_by.length > 0) {
        const current = Array.isArray(after.blockedBy) ? [...after.blockedBy] : [];
        for (const item of add_blocked_by) {
          if (!current.includes(item)) current.push(item);
        }
        after.blockedBy = current;
        updated = true;
      }

      if (isObject(metadata_patch)) {
        const base = isObject(after.metadata) ? after.metadata : {};
        after.metadata = { ...base, ...metadata_patch };
        updated = true;
      }

      if (updated) {
        atomicWriteJson(taskFile, after);
        _invalidateCache(dirname(taskFile));
        // 콘텐츠 캐시 무효화
        _taskContentCache.delete(taskFile);
      }

      let afterMtime = beforeMtime;
      try { afterMtime = (await stat(taskFile)).mtimeMs; } catch {}

      return {
        ok: true,
        data: {
          claimed,
          updated,
          task_before: before,
          task_after: updated ? after : before,
          task_file: taskFile,
          mtime_ms: afterMtime,
        },
      };
    });
  } catch (e) {
    return err('TASK_UPDATE_FAILED', e.message);
  }
}

function sanitizeRecipientName(v) {
  return String(v || 'team-lead').replace(/[\\/:*?"<>|]/g, '_');
}

export async function teamSendMessage(args = {}) {
  const {
    team_name,
    from,
    to = 'team-lead',
    text,
    summary,
    color = 'blue',
  } = args;

  try {
    validateTeamName(team_name);
  } catch {
    return err('INVALID_TEAM_NAME', 'team_name 형식이 올바르지 않습니다');
  }

  if (!String(from || '').trim()) return err('INVALID_FROM', 'from이 필요합니다');
  if (!String(text || '').trim()) return err('INVALID_TEXT', 'text가 필요합니다');

  const paths = await resolveTeamPaths(team_name);
  if (!existsSync(paths.team_dir)) {
    return err('TEAM_NOT_FOUND', `팀 디렉토리가 없습니다: ${paths.team_dir}`);
  }

  const recipient = sanitizeRecipientName(to);
  const inboxFile = join(paths.inboxes_dir, `${recipient}.json`);
  const lockFile = `${inboxFile}.lock`;
  let message;

  try {
    const unreadCount = await withFileLock(lockFile, async () => {
      const queue = await readJsonSafe(inboxFile);
      const list = Array.isArray(queue) ? queue : [];

      message = {
        id: randomUUID(),
        from: String(from),
        text: String(text),
        ...(summary ? { summary: String(summary) } : {}),
        timestamp: new Date().toISOString(),
        color: String(color || 'blue'),
        read: false,
      };
      list.push(message);

      // inbox 정리: 최대 200개 유지, read + 1시간 경과 메시지 제거
      const MAX_INBOX = 200;
      if (list.length > MAX_INBOX) {
        const ONE_HOUR_MS = 3600000;
        const cutoff = Date.now() - ONE_HOUR_MS;
        const pruned = list.filter((m) =>
          m?.read !== true || !m?.timestamp || new Date(m.timestamp).getTime() > cutoff
        );
        list.length = 0;
        list.push(...pruned);
        if (list.length > MAX_INBOX) {
          list.splice(0, list.length - MAX_INBOX);
        }
      }

      atomicWriteJson(inboxFile, list);

      return list.filter((m) => m?.read !== true).length;
    });

    return {
      ok: true,
      data: {
        message_id: message.id,
        recipient,
        inbox_file: inboxFile,
        queued_at: message.timestamp,
        unread_count: unreadCount,
      },
    };
  } catch (e) {
    return err('SEND_MESSAGE_FAILED', e.message);
  }
}
