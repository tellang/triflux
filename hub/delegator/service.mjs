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
  } = {}) {
    this.idFactory = idFactory;
    this.now = now;
    this.jobs = new Map();
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

  async delegate(_input) {
    throw new Error('Not implemented: wire delegate to the resident worker pool and Hub pipe action.');
  }

  async reply(_input) {
    throw new Error('Not implemented: wire delegate-reply to the resident conversation handler.');
  }

  async status({ job_id: jobId } = {}) {
    const snapshot = this.getStatusSnapshot(jobId);
    if (snapshot) {
      return snapshot;
    }

    const timestamp = this.now().toISOString();

    return {
      ok: false,
      job_id: jobId || 'unknown-job',
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
}
