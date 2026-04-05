// hub/hitl.mjs — Human-in-the-Loop 매니저
// 사용자 입력 요청/응답, 타임아웃 자동 처리

/**
 * HITL 매니저 생성
 * @param {object} store — createStore() 반환 객체
 * @param {object} router — createRouter() 반환 객체
 */
export function createHitlManager(store, router = null) {
  function forwardHumanResponse({ requesterAgent, requestId, action, content, submittedBy, correlationId, traceId, priority }) {
    if (!router?.handlePublish) {
      throw new Error('router.handlePublish is required for HITL forwarding');
    }
    return router.handlePublish({
      from: 'hub:hitl',
      to: requesterAgent,
      topic: 'human.response',
      priority,
      ttl_ms: 300000,
      payload: { request_id: requestId, action, content, submitted_by: submittedBy },
      correlation_id: correlationId,
      trace_id: traceId,
      message_type: 'human_response',
    });
  }

  return {
    /**
     * 사용자에게 입력 요청 생성
     * 터미널에 알림 출력 후 pending 상태로 저장
     */
    requestHumanInput({
      requester_agent, kind, prompt, requested_schema = {},
      deadline_ms, default_action, channel_preference = 'terminal',
      correlation_id, trace_id,
    }) {
      const result = store.insertHumanRequest({
        requester_agent, kind, prompt, requested_schema,
        deadline_ms, default_action,
        correlation_id, trace_id,
      });

      // 터미널 알림 (stderr — stdout은 MCP 용)
      const kindLabel = { captcha: 'CAPTCHA', approval: '승인', credential: '자격증명', choice: '선택', text: '텍스트' };
      process.stderr.write(
        `\n[tfx-hub] 사용자 입력 요청 (${kindLabel[kind] || kind})\n` +
        `  요청자: ${requester_agent}\n` +
        `  내용: ${prompt}\n` +
        `  ID: ${result.request_id}\n` +
        `  제한: ${Math.round(deadline_ms / 1000)}초\n\n`,
      );

      return { ok: true, data: result };
    },

    /**
     * 사용자 입력 응답 제출
     * 유효성 검증 → 상태 업데이트 → 요청자에게 응답 메시지 전달
     */
    submitHumanInput({ request_id, action, content = null, submitted_by = 'human' }) {
      // 요청 조회
      const hr = store.getHumanRequest(request_id);
      if (!hr) {
        return { ok: false, error: { code: 'NOT_FOUND', message: `요청 없음: ${request_id}` } };
      }
      if (hr.state !== 'pending') {
        return { ok: false, error: { code: 'ALREADY_HANDLED', message: `이미 처리됨: ${hr.state}` } };
      }

      // 상태 매핑
      const stateMap = { accept: 'accepted', decline: 'declined', cancel: 'cancelled' };
      const newState = stateMap[action];
      if (!newState) {
        return { ok: false, error: { code: 'INVALID_ACTION', message: `잘못된 action: ${action}` } };
      }

      // DB 업데이트
      store.updateHumanRequest(request_id, newState, content);

      // 요청자에게 응답 메시지 전달
      let forwardedMessageId = null;
      if (action === 'accept' || action === 'decline') {
        const published = forwardHumanResponse({
          requesterAgent: hr.requester_agent,
          requestId: request_id,
          action,
          content,
          submittedBy: submitted_by,
          correlationId: hr.correlation_id,
          traceId: hr.trace_id,
          priority: 7,
        });
        forwardedMessageId = published.data?.message_id || null;
      }

      return {
        ok: true,
        data: { request_id, new_state: newState, forwarded_message_id: forwardedMessageId },
      };
    },

    /**
     * 만료된 요청 자동 처리
     * deadline 초과 시 default_action 적용
     */
    checkTimeouts() {
      const pending = store.getPendingHumanRequests();
      const now = Date.now();
      const expired = pending.filter(hr => hr.deadline_ms <= now);
      if (!expired.length) return 0;

      const expireRequests = () => {
        for (const hr of expired) {
          store.updateHumanRequest(hr.request_id, 'timed_out', null);
          if (hr.default_action === 'timeout_continue') {
            forwardHumanResponse({
              requesterAgent: hr.requester_agent,
              requestId: hr.request_id,
              action: 'timeout_continue',
              content: null,
              submittedBy: 'system',
              correlationId: hr.correlation_id,
              traceId: hr.trace_id,
              priority: 5,
            });
          }
        }
        return expired.length;
      };

      const processExpired = store.db?.transaction
        ? store.db.transaction(expireRequests)
        : expireRequests;

      return processExpired();
    },

    /** 대기 중인 요청 목록 */
    getPendingRequests() {
      return store.getPendingHumanRequests();
    },
  };
}
