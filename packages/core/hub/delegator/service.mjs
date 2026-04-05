import { randomUUID } from 'node:crypto';

import {
  DELEGATOR_JOB_STATUSES,
  DELEGATOR_MODES,
  DELEGATOR_PROVIDERS,
} from './contracts.mjs';
import { getDelegatorMcpToolDefinitions } from './tool-definitions.mjs';

function deepClone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function assertKnown(enumValues, value, fieldName) {
  if (value == null) return;
  if (!enumValues.includes(value)) {
    throw new Error(`Unsupported ${fieldName}: ${value}`);
  }
}

export class DelegatorService {
  constructor({
    idFactory = randomUUID,
    now = () => new Date(),
    worker = null,
  } = {}) {
    this.idFactory = idFactory;
    this.now = now;
    this.jobs = new Map();
    this.worker = worker;
    this._workerJobMap = new Map();
  }

  listToolDefinitions() {
    return getDelegatorMcpToolDefinitions();
  }

  createJobSnapshot(input = {}) {
    const timestamp = this.now().toISOString();
    const jobId = input.job_id || this.idFactory();
    const mode = input.mode || 'sync';
    const providerRequested = input.provider || 'auto';

    assertKnown(DELEGATOR_MODES, mode, 'mode');
    assertKnown(DELEGATOR_PROVIDERS, providerRequested, 'provider');

    return {
      ok: true,
      job_id: jobId,
      status: 'queued',
      mode,
      provider_requested: providerRequested,
      provider_resolved: null,
      agent_type: input.agent_type || 'executor',
      transport: 'resident-pending',
      created_at: timestamp,
      started_at: null,
      updated_at: timestamp,
      completed_at: null,
      output: '',
      stderr: '',
      error: '',
      thread_id: input.thread_id || null,
      session_key: input.session_key || null,
      conversation_open: false,
    };
  }

  recordJob(snapshot) {
    if (!snapshot?.job_id) {
      throw new Error('job_id is required');
    }
    assertKnown(DELEGATOR_JOB_STATUSES, snapshot.status, 'status');
    this.jobs.set(snapshot.job_id, deepClone(snapshot));
    return this.getStatusSnapshot(snapshot.job_id);
  }

  getStatusSnapshot(jobId) {
    const snapshot = this.jobs.get(jobId);
    return snapshot ? deepClone(snapshot) : null;
  }

  // -- 필드 정규화 헬퍼 --

  _normalizeInput(input = {}) {
    return {
      prompt: input.prompt,
      provider: input.provider || 'auto',
      mode: input.mode || 'sync',
      agent_type: input.agent_type || input.agentType || 'executor',
      cwd: input.cwd || null,
      timeout_ms: input.timeout_ms || input.timeoutMs || null,
      session_key: input.session_key || input.sessionKey || null,
      thread_id: input.thread_id || input.threadId || null,
      reset_session: input.reset_session ?? input.resetSession ?? false,
      mcp_profile: input.mcp_profile || input.mcpProfile || 'auto',
      search_tool: input.search_tool || input.searchTool || null,
      context_file: input.context_file || input.contextFile || null,
      model: input.model || null,
      developer_instructions: input.developer_instructions || input.developerInstructions || null,
      compact_prompt: input.compact_prompt || input.compactPrompt || null,
    };
  }

  _toWorkerArgs(normalized) {
    return {
      prompt: normalized.prompt,
      provider: normalized.provider,
      mode: normalized.mode,
      agentType: normalized.agent_type,
      cwd: normalized.cwd,
      timeoutMs: normalized.timeout_ms,
      sessionKey: normalized.session_key,
      threadId: normalized.thread_id,
      resetSession: normalized.reset_session,
      mcpProfile: normalized.mcp_profile,
      searchTool: normalized.search_tool,
      contextFile: normalized.context_file,
      model: normalized.model,
      developerInstructions: normalized.developer_instructions,
      compactPrompt: normalized.compact_prompt,
    };
  }

  _applyWorkerResult(jobId, workerResult) {
    const snapshot = this.jobs.get(jobId);
    if (!snapshot) return null;

    const timestamp = this.now().toISOString();
    const ok = workerResult.ok !== false;

    snapshot.ok = ok;
    snapshot.status = workerResult.status || (ok ? 'completed' : 'failed');
    snapshot.provider_resolved = workerResult.providerResolved || workerResult.provider_resolved || null;
    snapshot.transport = workerResult.transport || snapshot.transport;
    snapshot.output = workerResult.output || '';
    snapshot.stderr = workerResult.stderr || '';
    snapshot.error = workerResult.error || '';
    snapshot.thread_id = workerResult.threadId || workerResult.thread_id || null;
    snapshot.session_key = workerResult.sessionKey || workerResult.session_key || null;
    snapshot.conversation_open = workerResult.conversationOpen ?? workerResult.conversation_open ?? false;
    snapshot.started_at = snapshot.started_at || timestamp;
    snapshot.updated_at = timestamp;
    if (snapshot.status === 'completed' || snapshot.status === 'failed') {
      snapshot.completed_at = timestamp;
    }

    this.jobs.set(jobId, deepClone(snapshot));
    return deepClone(snapshot);
  }

  _failJob(jobId, error) {
    const snapshot = this.jobs.get(jobId);
    if (snapshot) {
      const timestamp = this.now().toISOString();
      snapshot.ok = false;
      snapshot.status = 'failed';
      snapshot.error = error;
      snapshot.updated_at = timestamp;
      snapshot.completed_at = timestamp;
      this.jobs.set(jobId, deepClone(snapshot));
      return deepClone(snapshot);
    }
    return this._errorSnapshot(jobId, error);
  }

  _errorSnapshot(jobId, error) {
    const timestamp = this.now().toISOString();
    return {
      ok: false,
      job_id: jobId || 'unknown',
      status: 'failed',
      mode: 'sync',
      provider_requested: 'auto',
      provider_resolved: null,
      agent_type: 'executor',
      transport: 'resident-pending',
      created_at: timestamp,
      started_at: null,
      updated_at: timestamp,
      completed_at: timestamp,
      output: '',
      stderr: '',
      error,
      thread_id: null,
      session_key: null,
      conversation_open: false,
    };
  }

  // -- 위임/응답/상태 메서드 --

  async delegate(input = {}) {
    const normalized = this._normalizeInput(input);

    if (!normalized.prompt || typeof normalized.prompt !== 'string' || !normalized.prompt.trim()) {
      return this._errorSnapshot(null, 'prompt is required');
    }

    const snapshot = this.createJobSnapshot(normalized);
    this.recordJob(snapshot);

    if (!this.worker) {
      return this._failJob(snapshot.job_id, 'worker가 설정되지 않았습니다');
    }

    const workerArgs = this._toWorkerArgs(normalized);

    try {
      const workerResult = await this.worker.delegate(workerArgs, null);

      // worker job ID 매핑 (reply/status에서 사용)
      const workerJobId = workerResult.jobId || workerResult.job_id;
      if (workerJobId) {
        this._workerJobMap.set(snapshot.job_id, workerJobId);
      }

      return this._applyWorkerResult(snapshot.job_id, workerResult);
    } catch (err) {
      return this._failJob(snapshot.job_id, err instanceof Error ? err.message : String(err));
    }
  }

  async reply(input = {}) {
    const jobId = input.job_id || input.jobId;
    if (!jobId) {
      return this._errorSnapshot('unknown', 'job_id is required');
    }

    const snapshot = this.jobs.get(jobId);
    if (!snapshot) {
      return this._errorSnapshot(jobId, 'job not found');
    }

    if (!snapshot.conversation_open) {
      return this._failJob(jobId, 'conversation is not open');
    }

    if (!this.worker) {
      return this._failJob(jobId, 'worker가 설정되지 않았습니다');
    }

    const workerJobId = this._workerJobMap.get(jobId);
    if (!workerJobId) {
      return this._failJob(jobId, 'worker job 매핑을 찾을 수 없습니다');
    }

    try {
      const workerResult = await this.worker.reply({
        job_id: workerJobId,
        reply: input.reply,
        done: input.done ?? false,
      }, null);

      return this._applyWorkerResult(jobId, workerResult);
    } catch (err) {
      return this._failJob(jobId, err instanceof Error ? err.message : String(err));
    }
  }

  async status({ job_id: jobId, jobId: jobIdAlias } = {}) {
    const resolvedId = jobId || jobIdAlias;
    const snapshot = this.getStatusSnapshot(resolvedId);

    if (!snapshot) {
      const timestamp = this.now().toISOString();
      return {
        ok: false,
        job_id: resolvedId || 'unknown-job',
        status: 'failed',
        mode: 'async',
        provider_requested: 'auto',
        provider_resolved: null,
        agent_type: 'executor',
        transport: 'resident-pending',
        created_at: timestamp,
        started_at: null,
        updated_at: timestamp,
        completed_at: null,
        output: '',
        stderr: '',
        error: 'job not found',
        thread_id: null,
        session_key: null,
        conversation_open: false,
      };
    }

    // running/queued 상태이면 worker에서 최신 상태 갱신
    if (this.worker && (snapshot.status === 'running' || snapshot.status === 'queued')) {
      const workerJobId = this._workerJobMap.get(resolvedId);
      if (workerJobId) {
        try {
          const workerResult = await this.worker.getJobStatus(workerJobId, null);
          if (workerResult && workerResult.ok !== undefined) {
            return this._applyWorkerResult(resolvedId, workerResult);
          }
        } catch {
          // worker 상태 확인 실패 시 캐시된 snapshot 반환
        }
      }
    }

    return snapshot;
  }
}
