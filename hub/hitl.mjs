// hub/hitl.mjs — Human-in-the-Loop 매니저
// 사용자 입력 요청/응답, 타임아웃 자동 처리
import { uuidv7 } from './store.mjs';

/**
 * HITL 매니저 생성
 * @param {object} store — createStore() 반환 객체
 */
export function createHitlManager(store) {
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
        const msg = store.enqueueMessage({
          type: 'human_response',
          from: 'hub:hitl',
          to: hr.requester_agent,
          topic: 'human.response',
          priority: 7, // urgent — 사용자 블로킹 해소
          ttl_ms: 300000,
          payload: { request_id, action, content, submitted_by },
          correlation_id: hr.correlation_id,
          trace_id: hr.trace_id,
        });
        store.deliverToAgent(msg.id, hr.requester_agent);
        forwardedMessageId = msg.id;
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
      let processed = 0;

      for (const hr of pending) {
        if (hr.deadline_ms > now) continue;

        // default_action 적용
        if (hr.default_action === 'timeout_continue') {
          store.updateHumanRequest(hr.request_id, 'timed_out', null);
          // 요청자에게 타임아웃 알림
          const msg = store.enqueueMessage({
            type: 'human_response',
            from: 'hub:hitl',
            to: hr.requester_agent,
            topic: 'human.response',
            priority: 5,
            ttl_ms: 300000,
            payload: { request_id: hr.request_id, action: 'timeout_continue', content: null },
            correlation_id: hr.correlation_id,
            trace_id: hr.trace_id,
          });
          store.deliverToAgent(msg.id, hr.requester_agent);
        } else {
          // decline 또는 cancel
          store.updateHumanRequest(hr.request_id, 'timed_out', null);
        }
        processed++;
      }

      return processed;
    },

    /** 대기 중인 요청 목록 */
    getPendingRequests() {
      return store.getPendingHumanRequests();
    },
  };
}
