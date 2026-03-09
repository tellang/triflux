// hub/tools.mjs — MCP 도구 8개 정의
// register, status, publish, ask, poll_messages, handoff, request_human_input, submit_human_input
// 모든 도구 응답: { ok: boolean, error?: { code, message }, data?: ... }

/**
 * MCP 도구 목록 생성
 * @param {object} store  — createStore() 반환
 * @param {object} router — createRouter() 반환
 * @param {object} hitl   — createHitlManager() 반환
 * @returns {Array<{name, description, inputSchema, handler}>}
 */
export function createTools(store, router, hitl) {
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
        const data = store.registerAgent(args);
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
      description: '에이전트 수신함에서 대기 메시지를 가져옵니다. ack_ids로 이전 메시지 확인 가능',
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
      handler: wrap('POLL_FAILED', async (args) => {
        // ACK 먼저 처리
        const ackedIds = [];
        if (args.ack_ids?.length) {
          store.ackMessages(args.ack_ids, args.agent_id);
          ackedIds.push(...args.ack_ids);
        }

        // 1차 폴링
        let messages = store.pollForAgent(args.agent_id, {
          max_messages: args.max_messages,
          include_topics: args.include_topics,
          auto_ack: args.auto_ack,
        });

        // wait_ms > 0 이고 메시지 없으면 짧은 간격으로 반복 재시도
        if (!messages.length && args.wait_ms > 0) {
          const interval = Math.min(args.wait_ms, 500);
          const deadline = Date.now() + Math.min(args.wait_ms, 30000);
          while (!messages.length && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, interval));
            messages = store.pollForAgent(args.agent_id, {
              max_messages: args.max_messages,
              include_topics: args.include_topics,
              auto_ack: args.auto_ack,
            });
          }
        }

        return {
          ok: true,
          data: {
            messages,
            acked_ids: ackedIds,
            next_poll_after_ms: messages.length ? 0 : 1000,
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
  ];
}
