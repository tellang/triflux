// hub/tools.mjs — MCP 도구 정의
// register/status/publish/ask/poll/handoff/HITL + team proxy
// 모든 도구 응답: { ok: boolean, error?: { code, message }, data?: ... }

import {
  teamInfo,
  teamTaskList,
  teamTaskUpdate,
  teamSendMessage,
} from './team/nativeProxy.mjs';
import {
  ensurePipelineTable,
  createPipeline,
} from './pipeline/index.mjs';
import {
  readPipelineState,
  initPipelineState,
  listPipelineStates,
} from './pipeline/state.mjs';

/**
 * MCP 도구 목록 생성
 * @param {object} store  — createStore() 반환
 * @param {object} router — createRouter() 반환
 * @param {object} hitl   — createHitlManager() 반환
 * @param {object} pipe   — createPipeServer() 반환
 * @returns {Array<{name, description, inputSchema, handler}>}
 */
export function createTools(store, router, hitl, pipe = null) {
  /** 도구 핸들러 래퍼 — 에러 처리 + MCP content 형식 변환 */
  function wrap(code, fn) {
    return async (args) => {
      try {
        const result = await fn(args);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (e) {
        const err = { ok: false, error: { code, message: e.message } };
        return { content: [{ type: 'text', text: JSON.stringify(err) }], isError: true };
      }
    };
  }

  return [
    // ── 1. register ──
    {
      name: 'register',
      description: '에이전트를 허브에 등록하고 lease를 발급받습니다',
      inputSchema: {
        type: 'object',
        required: ['agent_id', 'cli', 'capabilities', 'topics', 'heartbeat_ttl_ms'],
        properties: {
          agent_id:         { type: 'string', pattern: '^[a-zA-Z0-9._:-]{3,64}$' },
          cli:              { type: 'string', enum: ['codex', 'gemini', 'claude', 'other'] },
          pid:              { type: 'integer', minimum: 1 },
          capabilities:     { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 64 },
          topics:           { type: 'array', items: { type: 'string' }, maxItems: 64 },
          metadata:         { type: 'object' },
          heartbeat_ttl_ms: { type: 'integer', minimum: 10000, maximum: 7200000 },
        },
      },
      handler: wrap('REGISTER_FAILED', (args) => {
        const data = router.registerAgent(args);
        return { ok: true, data };
      }),
    },

    // ── 2. status ──
    {
      name: 'status',
      description: '허브, 에이전트, 큐, 트레이스 상태를 조회합니다',
      inputSchema: {
        type: 'object',
        properties: {
          scope:           { type: 'string', enum: ['hub', 'agent', 'queue', 'trace'], default: 'hub' },
          agent_id:        { type: 'string' },
          trace_id:        { type: 'string' },
          include_metrics: { type: 'boolean', default: true },
        },
      },
      handler: wrap('STATUS_FAILED', (args) => {
        return router.getStatus(args.scope || 'hub', args);
      }),
    },

    // ── 3. publish ──
    {
      name: 'publish',
      description: '이벤트 또는 응답 메시지를 발행합니다. to에 "topic:XXX" 지정 시 구독자 전체 fanout',
      inputSchema: {
        type: 'object',
        required: ['from', 'to', 'topic', 'payload'],
        properties: {
          from:           { type: 'string', pattern: '^[a-zA-Z0-9._:-]{3,64}$' },
          to:             { type: 'string' },
          topic:          { type: 'string', pattern: '^[a-zA-Z0-9._:-]+$' },
          priority:       { type: 'integer', minimum: 1, maximum: 9, default: 5 },
          ttl_ms:         { type: 'integer', minimum: 1000, maximum: 86400000, default: 300000 },
          payload:        { type: 'object' },
          trace_id:       { type: 'string' },
          correlation_id: { type: 'string' },
        },
      },
      handler: wrap('PUBLISH_FAILED', (args) => {
        return router.handlePublish(args);
      }),
    },

    // ── 4. ask ──
    {
      name: 'ask',
      description: '다른 에이전트에게 질문합니다. await_response_ms > 0이면 짧은 폴링으로 응답 대기',
      inputSchema: {
        type: 'object',
        required: ['from', 'to', 'topic', 'question'],
        properties: {
          from:              { type: 'string', pattern: '^[a-zA-Z0-9._:-]{3,64}$' },
          to:                { type: 'string' },
          topic:             { type: 'string', pattern: '^[a-zA-Z0-9._:-]+$' },
          question:          { type: 'string', minLength: 1, maxLength: 20000 },
          context_refs:      { type: 'array', items: { type: 'string' }, maxItems: 32 },
          payload:           { type: 'object' },
          priority:          { type: 'integer', minimum: 1, maximum: 9, default: 5 },
          ttl_ms:            { type: 'integer', minimum: 1000, maximum: 86400000, default: 300000 },
          await_response_ms: { type: 'integer', minimum: 0, maximum: 30000, default: 0 },
          trace_id:          { type: 'string' },
          correlation_id:    { type: 'string' },
        },
      },
      handler: wrap('ASK_FAILED', async (args) => {
        return await router.handleAsk(args);
      }),
    },

    // ── 5. poll_messages ──
    {
      name: 'poll_messages',
      description: 'Deprecated. poll_messages 대신 Named Pipe subscribe/publish 채널을 사용합니다',
      inputSchema: {
        type: 'object',
        required: ['agent_id'],
        properties: {
          agent_id:       { type: 'string', pattern: '^[a-zA-Z0-9._:-]{3,64}$' },
          wait_ms:        { type: 'integer', minimum: 0, maximum: 30000, default: 1000 },
          max_messages:   { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          include_topics: { type: 'array', items: { type: 'string' }, maxItems: 64 },
          ack_ids:        { type: 'array', items: { type: 'string' }, maxItems: 100 },
          auto_ack:       { type: 'boolean', default: false },
        },
      },
      handler: wrap('POLL_DEPRECATED', async (args) => {
        const replay = router.drainAgent(args.agent_id, {
          max_messages: args.max_messages,
          include_topics: args.include_topics,
          auto_ack: args.auto_ack,
        });
        if (args.ack_ids?.length) {
          router.ackMessages(args.ack_ids, args.agent_id);
        }
        return {
          ok: false,
          error: {
            code: 'POLL_DEPRECATED',
            message: 'poll_messages는 deprecated 되었습니다. pipe subscribe/publish 채널을 사용하세요.',
          },
          data: {
            pipe_path: pipe?.path || null,
            delivery_mode: 'pipe_push',
            protocol: 'ndjson',
            replay: {
              messages: replay,
              count: replay.length,
            },
            server_time_ms: Date.now(),
          },
        };
      }),
    },

    // ── 6. handoff ──
    {
      name: 'handoff',
      description: '다른 에이전트에게 작업을 인계합니다. acceptance_criteria로 완료 기준 지정 가능',
      inputSchema: {
        type: 'object',
        required: ['from', 'to', 'topic', 'task'],
        properties: {
          from:                { type: 'string', pattern: '^[a-zA-Z0-9._:-]{3,64}$' },
          to:                  { type: 'string' },
          topic:               { type: 'string', pattern: '^[a-zA-Z0-9._:-]+$' },
          task:                { type: 'string', minLength: 1, maxLength: 20000 },
          acceptance_criteria: { type: 'array', items: { type: 'string' }, maxItems: 32 },
          context_refs:        { type: 'array', items: { type: 'string' }, maxItems: 32 },
          priority:            { type: 'integer', minimum: 1, maximum: 9, default: 5 },
          ttl_ms:              { type: 'integer', minimum: 1000, maximum: 86400000, default: 600000 },
          trace_id:            { type: 'string' },
          correlation_id:      { type: 'string' },
        },
      },
      handler: wrap('HANDOFF_FAILED', (args) => {
        return router.handleHandoff(args);
      }),
    },

    // ── 7. request_human_input ──
    {
      name: 'request_human_input',
      description: '사용자에게 입력을 요청합니다 (CAPTCHA, 승인, 자격증명, 선택, 텍스트)',
      inputSchema: {
        type: 'object',
        required: ['requester_agent', 'kind', 'prompt', 'requested_schema', 'deadline_ms', 'default_action'],
        properties: {
          requester_agent:    { type: 'string', pattern: '^[a-zA-Z0-9._:-]{3,64}$' },
          kind:               { type: 'string', enum: ['captcha', 'approval', 'credential', 'choice', 'text'] },
          prompt:             { type: 'string', minLength: 1, maxLength: 20000 },
          requested_schema:   { type: 'object' },
          deadline_ms:        { type: 'integer', minimum: 1000 },
          default_action:     { type: 'string', enum: ['decline', 'cancel', 'timeout_continue'] },
          channel_preference: { type: 'string', enum: ['terminal', 'pipe', 'file_polling'], default: 'terminal' },
          trace_id:           { type: 'string' },
          correlation_id:     { type: 'string' },
        },
      },
      handler: wrap('HITL_REQUEST_FAILED', (args) => {
        return hitl.requestHumanInput(args);
      }),
    },

    // ── 8. submit_human_input ──
    {
      name: 'submit_human_input',
      description: '사용자 입력 요청에 응답합니다 (accept, decline, cancel)',
      inputSchema: {
        type: 'object',
        required: ['request_id', 'action'],
        properties: {
          request_id:   { type: 'string' },
          action:       { type: 'string', enum: ['accept', 'decline', 'cancel'] },
          content:      { type: 'object' },
          submitted_by: { type: 'string', default: 'human' },
        },
      },
      handler: wrap('HITL_SUBMIT_FAILED', (args) => {
        return hitl.submitHumanInput(args);
      }),
    },

    // ── 9. team_info ──
    {
      name: 'team_info',
      description: 'Claude Native Teams 메타/멤버/경로 정보를 조회합니다',
      inputSchema: {
        type: 'object',
        required: ['team_name'],
        properties: {
          team_name: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-z0-9][a-z0-9-]*$' },
          include_members: { type: 'boolean', default: true },
          include_paths: { type: 'boolean', default: true },
        },
      },
      handler: wrap('TEAM_INFO_FAILED', (args) => {
        return teamInfo(args);
      }),
    },

    // ── 10. team_task_list ──
    {
      name: 'team_task_list',
      description: 'Claude Native Teams task 목록을 owner/status 조건으로 조회합니다',
      inputSchema: {
        type: 'object',
        required: ['team_name'],
        properties: {
          team_name: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
          owner: { type: 'string' },
          statuses: {
            type: 'array',
            items: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed', 'deleted'] },
            maxItems: 8,
          },
          include_internal: { type: 'boolean', default: false },
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200 },
        },
      },
      handler: wrap('TEAM_TASK_LIST_FAILED', (args) => {
        return teamTaskList(args);
      }),
    },

    // ── 11. team_task_update ──
    {
      name: 'team_task_update',
      description: 'Claude Native Teams task를 claim/update 합니다',
      inputSchema: {
        type: 'object',
        required: ['team_name', 'task_id'],
        properties: {
          team_name: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
          task_id: { type: 'string', minLength: 1, maxLength: 64 },
          claim: { type: 'boolean', default: false },
          owner: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed', 'deleted'] },
          subject: { type: 'string' },
          description: { type: 'string' },
          activeForm: { type: 'string' },
          add_blocks: { type: 'array', items: { type: 'string' } },
          add_blocked_by: { type: 'array', items: { type: 'string' } },
          metadata_patch: { type: 'object' },
          if_match_mtime_ms: { type: 'number' },
          actor: { type: 'string' },
        },
      },
      handler: wrap('TEAM_TASK_UPDATE_FAILED', (args) => {
        return teamTaskUpdate(args);
      }),
    },

    // ── 12. team_send_message ──
    {
      name: 'team_send_message',
      description: 'Claude Native Teams inbox에 메시지를 append 합니다',
      inputSchema: {
        type: 'object',
        required: ['team_name', 'from', 'text'],
        properties: {
          team_name: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
          from: { type: 'string', minLength: 1, maxLength: 128 },
          to: { type: 'string', default: 'team-lead' },
          text: { type: 'string', minLength: 1, maxLength: 200000 },
          summary: { type: 'string', maxLength: 1000 },
          color: { type: 'string', default: 'blue' },
        },
      },
      handler: wrap('TEAM_SEND_MESSAGE_FAILED', (args) => {
        return teamSendMessage(args);
      }),
    },

    // ── 13. pipeline_state ──
    {
      name: 'pipeline_state',
      description: '파이프라인 상태를 조회합니다 (--thorough 모드)',
      inputSchema: {
        type: 'object',
        required: ['team_name'],
        properties: {
          team_name: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
        },
      },
      handler: wrap('PIPELINE_STATE_FAILED', (args) => {
        ensurePipelineTable(store.db);
        const state = readPipelineState(store.db, args.team_name);
        return state
          ? { ok: true, data: state }
          : { ok: false, error: { code: 'PIPELINE_NOT_FOUND', message: `파이프라인 없음: ${args.team_name}` } };
      }),
    },

    // ── 14. pipeline_advance ──
    {
      name: 'pipeline_advance',
      description: '파이프라인을 다음 단계로 전이합니다 (전이 규칙 + fix loop 바운딩 적용)',
      inputSchema: {
        type: 'object',
        required: ['team_name', 'phase'],
        properties: {
          team_name: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
          phase: { type: 'string', enum: ['plan', 'prd', 'exec', 'verify', 'fix', 'complete', 'failed'] },
        },
      },
      handler: wrap('PIPELINE_ADVANCE_FAILED', (args) => {
        ensurePipelineTable(store.db);
        const pipeline = createPipeline(store.db, args.team_name);
        return pipeline.advance(args.phase);
      }),
    },

    // ── 15. pipeline_init ──
    {
      name: 'pipeline_init',
      description: '새 파이프라인을 초기화합니다 (기존 상태 덮어쓰기)',
      inputSchema: {
        type: 'object',
        required: ['team_name'],
        properties: {
          team_name: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
          fix_max: { type: 'integer', minimum: 1, maximum: 20, default: 3 },
          ralph_max: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
        },
      },
      handler: wrap('PIPELINE_INIT_FAILED', (args) => {
        ensurePipelineTable(store.db);
        const state = initPipelineState(store.db, args.team_name, {
          fix_max: args.fix_max,
          ralph_max: args.ralph_max,
        });
        return { ok: true, data: state };
      }),
    },

    // ── 16. pipeline_list ──
    {
      name: 'pipeline_list',
      description: '활성 파이프라인 목록을 조회합니다',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: wrap('PIPELINE_LIST_FAILED', () => {
        ensurePipelineTable(store.db);
        return { ok: true, data: listPipelineStates(store.db) };
      }),
    },
  ];
}
