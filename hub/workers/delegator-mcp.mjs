#!/usr/bin/env node
// hub/workers/delegator-mcp.mjs — triflux 위임용 MCP stdio 서버

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';

import { CodexMcpWorker } from './codex-mcp.mjs';
import { GeminiWorker } from './gemini-worker.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_INFO = { name: 'triflux-delegator', version: '1.0.0' };
const DEFAULT_CONTEXT_BYTES = 32 * 1024;
const DEFAULT_ROUTE_TIMEOUT_SEC = 120;
const DIRECT_PROGRESS_START = 5;
const DIRECT_PROGRESS_RUNNING = 60;
const DIRECT_PROGRESS_DONE = 100;

const AGENT_TIMEOUT_SEC = Object.freeze({
  executor: 1080,
  'build-fixer': 540,
  debugger: 900,
  'deep-executor': 3600,
  architect: 3600,
  planner: 3600,
  critic: 3600,
  analyst: 3600,
  'code-reviewer': 1800,
  'security-reviewer': 1800,
  'quality-reviewer': 1800,
  scientist: 1440,
  'scientist-deep': 3600,
  'document-specialist': 1440,
  designer: 900,
  writer: 900,
  explore: 300,
  verifier: 1200,
  'test-engineer': 300,
  'qa-tester': 300,
  spark: 180,
});

const CODEX_PROFILE_BY_AGENT = Object.freeze({
  executor: 'high',
  'build-fixer': 'fast',
  debugger: 'high',
  'deep-executor': 'xhigh',
  architect: 'xhigh',
  planner: 'xhigh',
  critic: 'xhigh',
  analyst: 'xhigh',
  'code-reviewer': 'thorough',
  'security-reviewer': 'thorough',
  'quality-reviewer': 'thorough',
  scientist: 'high',
  'scientist-deep': 'thorough',
  'document-specialist': 'high',
  verifier: 'thorough',
  spark: 'spark_fast',
});

const GEMINI_MODEL_BY_AGENT = Object.freeze({
  'build-fixer': 'gemini-3-flash-preview',
  writer: 'gemini-3-flash-preview',
  spark: 'gemini-3-flash-preview',
});

const REVIEW_INSTRUCTION_BY_AGENT = Object.freeze({
  'code-reviewer': '코드 리뷰 모드로 동작하라. 버그, 리스크, 회귀, 테스트 누락을 우선 식별하라.',
  'security-reviewer': '보안 리뷰 모드로 동작하라. 취약점, 권한 경계, 비밀정보 노출 가능성을 우선 식별하라.',
  'quality-reviewer': '품질 리뷰 모드로 동작하라. 로직 결함, 유지보수성 저하, 테스트 누락을 우선 식별하라.',
});

const IMPLEMENT_AGENT_SET = new Set(['executor', 'build-fixer', 'debugger', 'deep-executor']);
const ANALYZE_AGENT_SET = new Set(['architect', 'planner', 'critic', 'analyst', 'scientist', 'scientist-deep', 'document-specialist']);
const REVIEW_AGENT_SET = new Set(['code-reviewer', 'security-reviewer', 'quality-reviewer', 'verifier']);
const DOCS_AGENT_SET = new Set(['designer', 'writer']);
const SEARCH_TOOL_ORDER = ['brave-search', 'tavily', 'exa'];

function cloneEnv(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(([, value]) => typeof value === 'string'),
  );
}

function parseJsonArray(raw, fallback = []) {
  if (!raw) return [...fallback];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map((item) => String(item ?? '')).filter(Boolean)
      : [...fallback];
  } catch {
    return [...fallback];
  }
}

function resolveCandidatePath(candidate, cwd = process.cwd()) {
  if (!candidate) return null;
  const normalized = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
  return existsSync(normalized) ? normalized : null;
}

function resolveRouteScript(explicitPath, cwd = process.cwd()) {
  const candidates = [
    explicitPath,
    process.env.TFX_DELEGATOR_ROUTE_SCRIPT,
    process.env.TFX_ROUTE_SCRIPT,
    resolve(SCRIPT_DIR, '..', '..', 'scripts', 'tfx-route.sh'),
    resolve(cwd, 'scripts', 'tfx-route.sh'),
  ];

  for (const candidate of candidates) {
    const resolved = resolveCandidatePath(candidate, cwd);
    if (resolved) return resolved;
  }

  return null;
}

function resolveMcpProfile(agentType, requested = 'auto') {
  if (requested && requested !== 'auto') return requested;
  if (IMPLEMENT_AGENT_SET.has(agentType)) return 'implement';
  if (ANALYZE_AGENT_SET.has(agentType)) return 'analyze';
  if (REVIEW_AGENT_SET.has(agentType)) return 'review';
  if (DOCS_AGENT_SET.has(agentType)) return 'docs';
  return 'minimal';
}

function resolveSearchToolOrder(searchTool, workerIndex) {
  const available = [...SEARCH_TOOL_ORDER];
  if (searchTool && available.includes(searchTool)) {
    return [searchTool, ...available.filter((tool) => tool !== searchTool)];
  }

  if (Number.isInteger(workerIndex) && workerIndex > 0 && available.length > 1) {
    const offset = (workerIndex - 1) % available.length;
    return available.slice(offset).concat(available.slice(0, offset));
  }

  return available;
}

function buildPromptHint(profile, args) {
  const orderedTools = resolveSearchToolOrder(args.searchTool, args.workerIndex);
  switch (profile) {
    case 'implement':
      return [
        'context7으로 라이브러리 문서를 조회하세요.',
        `웹 검색은 ${orderedTools[0]}를 사용하세요.`,
        '검색 도구 실패 시 402, 429, 432, 433, quota 에러에서 재시도하지 말고 다음 도구로 전환하세요.',
      ].join(' ');
    case 'analyze':
      return [
        'context7으로 관련 문서를 조회하세요.',
        `웹 검색 우선순위: ${orderedTools.join(', ')}. 402, 429, 432, 433, quota 에러 시 즉시 다음 도구로 전환.`,
        '모든 검색 실패 시 playwright로 직접 방문 (최대 3 URL).',
        '검색 깊이를 제한하고 결과를 빠르게 요약하세요.',
      ].join(' ');
    case 'review':
      return 'sequential-thinking으로 체계적으로 분석하세요.';
    case 'docs':
      return [
        'context7으로 공식 문서를 참조하세요.',
        `추가 검색은 ${orderedTools[0]}를 사용하세요.`,
        '검색 결과의 출처 URL을 함께 제시하세요.',
      ].join(' ');
    default:
      return '';
  }
}

function resolveGeminiMcpServers(profile) {
  switch (profile) {
    case 'implement':
      return ['context7', 'brave-search'];
    case 'analyze':
      return ['context7', 'brave-search', 'exa', 'tavily'];
    case 'review':
      return ['sequential-thinking'];
    case 'docs':
      return ['context7', 'brave-search'];
    default:
      return [];
  }
}

function resolveCodexProfile(agentType) {
  return CODEX_PROFILE_BY_AGENT[agentType] || 'high';
}

function resolveGeminiModel(agentType) {
  return GEMINI_MODEL_BY_AGENT[agentType] || 'gemini-3.1-pro-preview';
}

function resolveTimeoutMs(agentType, timeoutMs) {
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return Math.trunc(timeoutMs);
  }

  const timeoutSec = AGENT_TIMEOUT_SEC[agentType] || DEFAULT_ROUTE_TIMEOUT_SEC;
  return timeoutSec * 1000;
}

function resolveTimeoutSec(agentType, timeoutMs) {
  const resolved = resolveTimeoutMs(agentType, timeoutMs);
  return Math.max(1, Math.ceil(resolved / 1000));
}

function loadContextFromFile(contextFile) {
  if (!contextFile) return '';
  const resolved = resolveCandidatePath(contextFile);
  if (!resolved) return '';
  try {
    return readFileSync(resolved, 'utf8').slice(0, DEFAULT_CONTEXT_BYTES);
  } catch {
    return '';
  }
}

function withContext(prompt, contextFile) {
  const context = loadContextFromFile(contextFile);
  if (!context) return prompt;
  return `${prompt}\n\n<prior_context>\n${context}\n</prior_context>`;
}

function withPromptHint(prompt, args) {
  const profile = resolveMcpProfile(args.agentType, args.mcpProfile);
  const hint = buildPromptHint(profile, args);
  if (!hint) return withContext(prompt, args.contextFile);
  return `${withContext(prompt, args.contextFile)}. ${hint}`;
}

function joinInstructions(...values) {
  return values
    .filter((value) => typeof value === 'string' && value.trim())
    .join('\n')
    .trim();
}

function parseRouteType(stderr = '') {
  const match = stderr.match(/type=([a-z-]+)/);
  if (!match) return null;
  if (match[1] === 'codex') return 'codex';
  if (match[1] === 'gemini') return 'gemini';
  return match[1];
}

function summarizePayload(payload) {
  if (typeof payload.output === 'string' && payload.output.trim()) return payload.output.trim();
  if (payload.mode === 'async' && payload.jobId) return `비동기 위임이 시작되었습니다. jobId=${payload.jobId}`;
  if (payload.jobId) return `jobId=${payload.jobId} 상태=${payload.status}`;
  if (payload.status) return `상태=${payload.status}`;
  return payload.ok ? '완료되었습니다.' : '실패했습니다.';
}

function createToolResponse(payload, { isError = false } = {}) {
  return {
    content: [{ type: 'text', text: summarizePayload(payload) }],
    structuredContent: payload,
    isError,
  };
}

function createErrorPayload(message, extras = {}) {
  return {
    ok: false,
    status: 'failed',
    error: message,
    ...extras,
  };
}

const DelegateInputSchema = z.object({
  prompt: z.string().min(1).describe('위임할 프롬프트'),
  provider: z.enum(['auto', 'codex', 'gemini']).default('auto').describe('사용할 provider'),
  mode: z.enum(['sync', 'async']).default('sync').describe('동기 또는 비동기 실행'),
  agentType: z.string().default('executor').describe('tfx-route 역할명 또는 direct 실행 역할'),
  cwd: z.string().optional().describe('작업 디렉터리'),
  timeoutMs: z.number().int().positive().optional().describe('요청 타임아웃(ms)'),
  sessionKey: z.string().optional().describe('Codex warm session 재사용 키'),
  resetSession: z.boolean().optional().describe('기존 Codex 세션 초기화 여부'),
  mcpProfile: z.enum(['auto', 'implement', 'analyze', 'review', 'docs', 'minimal', 'none']).default('auto'),
  contextFile: z.string().optional().describe('tfx-route prior_context 파일 경로'),
  searchTool: z.enum(['brave-search', 'tavily', 'exa']).optional().describe('검색 우선 도구'),
  workerIndex: z.number().int().positive().optional().describe('병렬 워커 인덱스'),
  model: z.string().optional().describe('직접 실행 시 모델 오버라이드'),
  developerInstructions: z.string().optional().describe('직접 실행 시 추가 개발자 지침'),
  compactPrompt: z.string().optional().describe('Codex compact prompt'),
  threadId: z.string().optional().describe('Codex 직접 실행 시 기존 threadId'),
  codexTransport: z.enum(['auto', 'mcp', 'exec']).optional().describe('route 경로용 Codex transport'),
  noClaudeNative: z.boolean().optional().describe('route 경로용 TFX_NO_CLAUDE_NATIVE'),
  teamName: z.string().optional().describe('TFX_TEAM_NAME'),
  teamTaskId: z.string().optional().describe('TFX_TEAM_TASK_ID'),
  teamAgentName: z.string().optional().describe('TFX_TEAM_AGENT_NAME'),
  teamLeadName: z.string().optional().describe('TFX_TEAM_LEAD_NAME'),
  hubUrl: z.string().optional().describe('TFX_HUB_URL'),
});

const DelegateStatusInputSchema = z.object({
  jobId: z.string().min(1).describe('조회할 비동기 job ID'),
});

const DelegateOutputSchema = z.object({
  ok: z.boolean(),
  jobId: z.string().optional(),
  mode: z.enum(['sync', 'async']).optional(),
  status: z.enum(['running', 'completed', 'failed']).optional(),
  error: z.string().optional(),
  providerRequested: z.string().optional(),
  providerResolved: z.string().nullable().optional(),
  agentType: z.string().optional(),
  transport: z.string().optional(),
  createdAt: z.string().optional(),
  startedAt: z.string().optional(),
  updatedAt: z.string().optional(),
  completedAt: z.string().nullable().optional(),
  exitCode: z.number().nullable().optional(),
  output: z.string().optional(),
  stderr: z.string().optional(),
  threadId: z.string().nullable().optional(),
  sessionKey: z.string().nullable().optional(),
});

function isTeamRouteRequested(args) {
  return Boolean(
    args.teamName
    || args.teamTaskId
    || args.teamAgentName
    || args.teamLeadName
    || args.hubUrl
  );
}

function pickRouteMode(provider) {
  return provider === 'auto' ? 'auto' : provider;
}

async function emitProgress(extra, progress, total, message) {
  if (extra?._meta?.progressToken === undefined) return;
  await extra.sendNotification({
    method: 'notifications/progress',
    params: {
      progressToken: extra._meta.progressToken,
      progress,
      total,
      message,
    },
  });
}

export class DelegatorMcpWorker {
  type = 'delegator';

  constructor(options = {}) {
    this.cwd = options.cwd || process.cwd();
    this.env = cloneEnv({ ...cloneEnv(process.env), ...cloneEnv(options.env) });
    this.routeScript = resolveRouteScript(options.routeScript, this.cwd);
    this.bashCommand = options.bashCommand
      || this.env.TFX_DELEGATOR_BASH_COMMAND
      || this.env.BASH_BIN
      || 'bash';

    this.codexWorker = new CodexMcpWorker({
      command: options.codexCommand
        || this.env.TFX_DELEGATOR_CODEX_COMMAND
        || this.env.CODEX_BIN
        || 'codex',
      args: Array.isArray(options.codexArgs) && options.codexArgs.length
        ? options.codexArgs
        : parseJsonArray(this.env.TFX_DELEGATOR_CODEX_ARGS_JSON, []),
      cwd: this.cwd,
      env: this.env,
      clientInfo: { name: SERVER_INFO.name, version: SERVER_INFO.version },
    });

    this.geminiCommand = options.geminiCommand || this.env.GEMINI_BIN || 'gemini';
    this.geminiCommandArgs = Array.isArray(options.geminiArgs) && options.geminiArgs.length
      ? [...options.geminiArgs]
      : parseJsonArray(this.env.GEMINI_BIN_ARGS_JSON, []);

    this.server = null;
    this.transport = null;
    this.jobs = new Map();
    this.routeChildren = new Set();
    this.ready = false;
  }

  isReady() {
    return this.ready;
  }

  async start() {
    if (this.server) {
      this.ready = true;
      return;
    }

    const server = new McpServer(SERVER_INFO, {
      capabilities: { logging: {} },
    });

    server.registerTool('triflux-delegate', {
      description: '새 위임을 실행합니다. codex/gemini direct 경로와 tfx-route 기반 auto 라우팅을 모두 지원합니다.',
      inputSchema: DelegateInputSchema,
      outputSchema: DelegateOutputSchema,
    }, async (args, extra) => {
      const payload = await this.delegate(args, extra);
      return createToolResponse(payload, { isError: payload.ok === false && payload.mode !== 'async' });
    });

    server.registerTool('triflux-delegate-status', {
      description: '비동기 위임 job 상태를 조회합니다.',
      inputSchema: DelegateStatusInputSchema,
      outputSchema: DelegateOutputSchema,
    }, async ({ jobId }, extra) => {
      const payload = await this.getJobStatus(jobId, extra);
      return createToolResponse(payload, { isError: payload.ok === false });
    });

    this.server = server;
    this.ready = true;
  }

  async serveStdio() {
    await this.start();
    if (this.transport) return;
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    this.transport = transport;
  }

  async stop() {
    this.ready = false;

    for (const child of this.routeChildren) {
      try { child.kill(); } catch {}
    }
    this.routeChildren.clear();

    await this.codexWorker.stop().catch(() => {});

    for (const job of this.jobs.values()) {
      if (job.worker) {
        await job.worker.stop().catch(() => {});
        job.worker = null;
      }
    }

    if (this.server) {
      await this.server.close().catch(() => {});
    }

    this.server = null;
    this.transport = null;
  }

  async run(prompt, options = {}) {
    return this._executeDirect({ prompt, ...options });
  }

  async execute(prompt, options = {}) {
    const result = await this._executeDirect({ prompt, ...options });
    return {
      output: result.output || result.error || '',
      exitCode: result.exitCode ?? (result.ok ? 0 : 1),
      threadId: result.threadId || null,
      sessionKey: result.sessionKey || null,
      raw: result,
    };
  }

  async delegate(args, extra) {
    if (args.mode === 'async') {
      return this._startAsyncJob(args, extra);
    }
    return this._executeDirect(args, extra);
  }

  async getJobStatus(jobId, extra) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return createErrorPayload(`알 수 없는 jobId: ${jobId}`, { jobId });
    }

    const payload = this._serializeJob(job);
    if (job.status === 'running') {
      await emitProgress(extra, 25, 100, `job ${jobId} 실행 중`);
    } else if (job.status === 'completed') {
      await emitProgress(extra, DIRECT_PROGRESS_DONE, 100, `job ${jobId} 완료`);
    } else if (job.status === 'failed') {
      await emitProgress(extra, DIRECT_PROGRESS_DONE, 100, `job ${jobId} 실패`);
    }
    return payload;
  }

  _createGeminiWorker() {
    return new GeminiWorker({
      command: this.geminiCommand,
      commandArgs: this.geminiCommandArgs,
      cwd: this.cwd,
      env: this.env,
    });
  }

  _buildDirectPrompt(args) {
    return withContext(String(args.prompt ?? ''), args.contextFile);
  }

  _buildDirectPromptWithHint(args) {
    return withPromptHint(String(args.prompt ?? ''), {
      agentType: args.agentType || 'executor',
      mcpProfile: args.mcpProfile || 'auto',
      searchTool: args.searchTool,
      workerIndex: Number.isInteger(args.workerIndex) ? args.workerIndex : undefined,
      contextFile: args.contextFile,
    });
  }

  _buildPromptHintInstruction(args) {
    return buildPromptHint(resolveMcpProfile(args.agentType, args.mcpProfile), {
      agentType: args.agentType || 'executor',
      mcpProfile: args.mcpProfile || 'auto',
      searchTool: args.searchTool,
      workerIndex: Number.isInteger(args.workerIndex) ? args.workerIndex : undefined,
    });
  }

  _shouldUseRoute(args) {
    return args.provider === 'auto' || isTeamRouteRequested(args);
  }

  async _executeDirect(args, extra = null) {
    await emitProgress(extra, DIRECT_PROGRESS_START, 100, '위임 실행을 시작합니다.');

    const runViaRoute = this._shouldUseRoute(args);

    try {
      const result = runViaRoute
        ? await this._executeRoute(args, extra)
        : await this._executeWorker(args, extra);

      await emitProgress(extra, DIRECT_PROGRESS_DONE, 100, '위임이 완료되었습니다.');
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return createErrorPayload(message, {
        mode: 'sync',
        providerRequested: args.provider,
        agentType: args.agentType,
        transport: runViaRoute ? 'route-script' : `${args.provider}-worker`,
      });
    }
  }

  async _executeWorker(args, extra) {
    await emitProgress(extra, DIRECT_PROGRESS_RUNNING, 100, '직접 워커 경로로 실행 중입니다.');

    if (args.provider === 'codex') {
      const result = await this.codexWorker.execute(this._buildDirectPrompt(args), {
        cwd: args.cwd || this.cwd,
        timeoutMs: resolveTimeoutMs(args.agentType, args.timeoutMs),
        sessionKey: args.sessionKey,
        threadId: args.threadId,
        resetSession: args.resetSession,
        profile: resolveCodexProfile(args.agentType),
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
        developerInstructions: joinInstructions(
          REVIEW_INSTRUCTION_BY_AGENT[args.agentType],
          this._buildPromptHintInstruction(args),
          args.developerInstructions,
        ),
        compactPrompt: args.compactPrompt,
        model: args.model,
      });

      return {
        ok: result.exitCode === 0,
        mode: 'sync',
        status: result.exitCode === 0 ? 'completed' : 'failed',
        providerRequested: 'codex',
        providerResolved: 'codex',
        agentType: args.agentType,
        transport: 'codex-mcp',
        exitCode: result.exitCode,
        output: result.output,
        sessionKey: result.sessionKey,
        threadId: result.threadId,
      };
    }

    if (args.provider === 'gemini') {
      const worker = this._createGeminiWorker();
      try {
        const result = await worker.execute(this._buildDirectPromptWithHint(args), {
          cwd: args.cwd || this.cwd,
          timeoutMs: resolveTimeoutMs(args.agentType, args.timeoutMs),
          model: args.model || resolveGeminiModel(args.agentType),
          approvalMode: 'yolo',
          allowedMcpServerNames: resolveGeminiMcpServers(
            resolveMcpProfile(args.agentType, args.mcpProfile),
          ),
        });

        return {
          ok: result.exitCode === 0,
          mode: 'sync',
          status: result.exitCode === 0 ? 'completed' : 'failed',
          providerRequested: 'gemini',
          providerResolved: 'gemini',
          agentType: args.agentType,
          transport: 'gemini-worker',
          exitCode: result.exitCode,
          output: result.output,
          sessionKey: result.sessionKey,
        };
      } finally {
        await worker.stop().catch(() => {});
      }
    }

    return createErrorPayload(`지원하지 않는 direct provider: ${args.provider}`, {
      mode: 'sync',
      providerRequested: args.provider,
      agentType: args.agentType,
      transport: 'direct-worker',
    });
  }

  async _executeRoute(args, extra) {
    if (!this.routeScript) {
      return createErrorPayload('tfx-route.sh 경로를 찾지 못했습니다.', {
        mode: 'sync',
        providerRequested: args.provider,
        agentType: args.agentType,
        transport: 'route-script',
      });
    }

    await emitProgress(extra, DIRECT_PROGRESS_RUNNING, 100, 'tfx-route.sh 경로로 실행 중입니다.');
    const result = await this._spawnRoute(args);
    return {
      ok: result.exitCode === 0,
      mode: 'sync',
      status: result.exitCode === 0 ? 'completed' : 'failed',
      providerRequested: args.provider,
      providerResolved: parseRouteType(result.stderr) || args.provider,
      agentType: args.agentType,
      transport: 'route-script',
      exitCode: result.exitCode,
      output: result.stdout.trim() || result.stderr.trim(),
      stderr: result.stderr.trim(),
    };
  }

  async _startAsyncJob(args, extra) {
    const jobId = randomUUID();
    const startedAt = new Date().toISOString();
    const payload = {
      ok: true,
      jobId,
      mode: 'async',
      status: 'running',
      providerRequested: args.provider,
      providerResolved: null,
      agentType: args.agentType,
      transport: this._shouldUseRoute(args) ? 'route-script' : `${args.provider}-worker`,
      createdAt: startedAt,
      startedAt,
    };

    const job = {
      ...payload,
      updatedAt: startedAt,
      completedAt: null,
      output: '',
      stderr: '',
      exitCode: null,
      threadId: null,
      sessionKey: args.sessionKey || null,
      worker: null,
      child: null,
    };
    this.jobs.set(jobId, job);

    await emitProgress(extra, DIRECT_PROGRESS_START, 100, `비동기 job ${jobId}를 시작합니다.`);

    void (async () => {
      try {
        const result = this._shouldUseRoute(args)
          ? await this._spawnRoute(args, job)
          : await this._runAsyncWorker(args, job);

        job.ok = result.ok;
        job.status = result.ok ? 'completed' : 'failed';
        job.providerResolved = result.providerResolved || job.providerRequested;
        job.output = result.output || '';
        job.stderr = result.stderr || '';
        job.exitCode = result.exitCode ?? (result.ok ? 0 : 1);
        job.threadId = result.threadId || null;
        job.sessionKey = result.sessionKey || job.sessionKey || null;
        job.completedAt = new Date().toISOString();
        job.updatedAt = job.completedAt;
      } catch (error) {
        job.ok = false;
        job.status = 'failed';
        job.output = '';
        job.stderr = error instanceof Error ? error.message : String(error);
        job.exitCode = 1;
        job.completedAt = new Date().toISOString();
        job.updatedAt = job.completedAt;
      } finally {
        if (job.worker) {
          await job.worker.stop().catch(() => {});
          job.worker = null;
        }
        job.child = null;
      }
    })();

    return payload;
  }

  async _runAsyncWorker(args, job) {
    if (args.provider === 'codex') {
      const result = await this.codexWorker.execute(this._buildDirectPrompt(args), {
        cwd: args.cwd || this.cwd,
        timeoutMs: resolveTimeoutMs(args.agentType, args.timeoutMs),
        sessionKey: args.sessionKey,
        threadId: args.threadId,
        resetSession: args.resetSession,
        profile: resolveCodexProfile(args.agentType),
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
        developerInstructions: joinInstructions(
          REVIEW_INSTRUCTION_BY_AGENT[args.agentType],
          this._buildPromptHintInstruction(args),
          args.developerInstructions,
        ),
        compactPrompt: args.compactPrompt,
        model: args.model,
      });

      return {
        ok: result.exitCode === 0,
        providerResolved: 'codex',
        output: result.output,
        exitCode: result.exitCode,
        threadId: result.threadId,
        sessionKey: result.sessionKey,
      };
    }

    if (args.provider === 'gemini') {
      const worker = this._createGeminiWorker();
      job.worker = worker;
      const result = await worker.execute(this._buildDirectPromptWithHint(args), {
        cwd: args.cwd || this.cwd,
        timeoutMs: resolveTimeoutMs(args.agentType, args.timeoutMs),
        model: args.model || resolveGeminiModel(args.agentType),
        approvalMode: 'yolo',
        allowedMcpServerNames: resolveGeminiMcpServers(
          resolveMcpProfile(args.agentType, args.mcpProfile),
        ),
      });

      return {
        ok: result.exitCode === 0,
        providerResolved: 'gemini',
        output: result.output,
        exitCode: result.exitCode,
        sessionKey: result.sessionKey,
      };
    }

    throw new Error(`지원하지 않는 async provider: ${args.provider}`);
  }

  _buildRouteEnv(args) {
    const env = cloneEnv(this.env);
    env.TFX_CLI_MODE = pickRouteMode(args.provider);

    if (args.codexTransport) {
      env.TFX_CODEX_TRANSPORT = args.codexTransport;
    }
    if (args.noClaudeNative === true) {
      env.TFX_NO_CLAUDE_NATIVE = '1';
    }
    if (args.searchTool) {
      env.TFX_SEARCH_TOOL = args.searchTool;
    }
    if (Number.isInteger(args.workerIndex) && args.workerIndex > 0) {
      env.TFX_WORKER_INDEX = String(args.workerIndex);
    }
    if (args.teamName) env.TFX_TEAM_NAME = args.teamName;
    if (args.teamTaskId) env.TFX_TEAM_TASK_ID = args.teamTaskId;
    if (args.teamAgentName) env.TFX_TEAM_AGENT_NAME = args.teamAgentName;
    if (args.teamLeadName) env.TFX_TEAM_LEAD_NAME = args.teamLeadName;
    if (args.hubUrl) env.TFX_HUB_URL = args.hubUrl;

    return env;
  }

  async _spawnRoute(args, job = null) {
    const prompt = withContext(String(args.prompt ?? ''), args.contextFile);
    const childArgs = [
      this.routeScript,
      args.agentType || 'executor',
      prompt,
      args.mcpProfile || 'auto',
      String(resolveTimeoutSec(args.agentType, args.timeoutMs)),
    ];

    const child = spawn(this.bashCommand, childArgs, {
      cwd: args.cwd || this.cwd,
      env: this._buildRouteEnv(args),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    if (job) {
      job.child = child;
    }

    this.routeChildren.add(child);

    return await new Promise((resolvePromise, rejectPromise) => {
      const stdoutChunks = [];
      const stderrChunks = [];

      child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
      child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
      child.once('error', (error) => {
        this.routeChildren.delete(child);
        rejectPromise(error);
      });
      child.once('close', (code) => {
        this.routeChildren.delete(child);
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        resolvePromise({
          ok: code === 0,
          providerResolved: parseRouteType(stderr) || args.provider,
          output: stdout.trim() || stderr.trim(),
          stdout,
          stderr,
          exitCode: code ?? 1,
        });
      });
    });
  }

  _serializeJob(job) {
    return {
      ok: job.ok,
      jobId: job.jobId,
      mode: 'async',
      status: job.status,
      providerRequested: job.providerRequested,
      providerResolved: job.providerResolved,
      agentType: job.agentType,
      transport: job.transport,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt,
      exitCode: job.exitCode,
      output: job.output,
      stderr: job.stderr,
      threadId: job.threadId,
      sessionKey: job.sessionKey,
    };
  }
}

export function createDelegatorMcpWorker(options = {}) {
  return new DelegatorMcpWorker(options);
}

export async function runDelegatorMcpCli() {
  const worker = createDelegatorMcpWorker();
  try {
    await worker.serveStdio();
  } catch (error) {
    console.error(`[delegator-mcp] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runDelegatorMcpCli();
}
