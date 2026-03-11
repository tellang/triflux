// hub/router.mjs — Actor mailbox 라우터 + QoS 스케줄러
// 메시지 라우팅, ask/publish/handoff 처리, TTL 정리
import { EventEmitter, once } from 'node:events';
import { uuidv7 } from './store.mjs';

/**
 * 라우터 생성
 * @param {object} store — createStore() 반환 객체
 */
export function createRouter(store) {
  let sweepTimer = null;
  let staleTimer = null;
  const responseEmitter = new EventEmitter();
  responseEmitter.setMaxListeners(200);

  const router = {
    /**
     * 메시지를 대상에게 라우팅
     * "topic:XXX" → 토픽 구독자 전체 fanout
     * 직접 agent_id → 1:1 배달
     * @returns {number} 배달된 에이전트 수
     */
    route(msg) {
      const to = msg.to_agent ?? msg.to;
      if (to.startsWith('topic:')) {
        return store.deliverToTopic(msg.id, to.slice(6));
      }
      store.deliverToAgent(msg.id, to);
      return 1;
    },

    /**
     * ask — 질문 요청 (request/reply 패턴)
     * await_response_ms > 0 이면 짧은 폴링으로 응답 대기
     * 0 이면 티켓(correlation_id) 즉시 반환
     */
    async handleAsk({
      from, to, topic, question, context_refs,
      payload = {}, priority = 5, ttl_ms = 300000,
      await_response_ms = 0, trace_id, correlation_id,
    }) {
      const cid = correlation_id || uuidv7();
      const tid = trace_id || uuidv7();

      const msg = store.enqueueMessage({
        type: 'request', from, to, topic, priority, ttl_ms,
        payload: { question, context_refs, ...payload },
        correlation_id: cid, trace_id: tid,
      });
      router.route(msg);

      // 티켓 모드: 즉시 반환
      if (await_response_ms <= 0) {
        return {
          ok: true,
          data: { request_message_id: msg.id, correlation_id: cid, trace_id: tid, state: 'queued' },
        };
      }

      // 이벤트 기반 대기 (최대 30초 제한)
      try {
        const [payload] = await once(responseEmitter, cid, {
          signal: AbortSignal.timeout(Math.min(await_response_ms, 30000)),
        });
        return {
          ok: true,
          data: { request_message_id: msg.id, correlation_id: cid, trace_id: tid, state: 'answered', response: payload },
        };
      } catch {
        // 타임아웃 — DB에서 최종 확인
        const resp = store.getResponseByCorrelation(cid);
        if (resp) {
          return {
            ok: true,
            data: { request_message_id: msg.id, correlation_id: cid, trace_id: tid, state: 'answered', response: resp.payload },
          };
        }
        return {
          ok: true,
          data: { request_message_id: msg.id, correlation_id: cid, trace_id: tid, state: 'delivered' },
        };
      }
    },

    /**
     * publish — 이벤트/응답 발행
     * correlation_id 존재 시 response 타입, 없으면 event 타입
     */
    handlePublish({
      from, to, topic, priority = 5, ttl_ms = 300000,
      payload = {}, trace_id, correlation_id,
    }) {
      const type = correlation_id ? 'response' : 'event';
      const msg = store.enqueueMessage({
        type, from, to, topic, priority, ttl_ms, payload,
        correlation_id: correlation_id || uuidv7(),
        trace_id: trace_id || uuidv7(),
      });
      const fanout = router.route(msg);
      if (correlation_id) {
        responseEmitter.emit(correlation_id, msg.payload);
      }
      return {
        ok: true,
        data: { message_id: msg.id, fanout_count: fanout, expires_at_ms: msg.expires_at_ms },
      };
    },

    /**
     * handoff — 작업 인계
     * acceptance_criteria, context_refs 포함 가능
     */
    handleHandoff({
      from, to, topic, task, acceptance_criteria, context_refs,
      priority = 5, ttl_ms = 600000, trace_id, correlation_id,
    }) {
      const msg = store.enqueueMessage({
        type: 'handoff', from, to, topic, priority, ttl_ms,
        payload: { task, acceptance_criteria, context_refs },
        correlation_id: correlation_id || uuidv7(),
        trace_id: trace_id || uuidv7(),
      });
      router.route(msg);
      return {
        ok: true,
        data: { handoff_message_id: msg.id, state: 'queued', assigned_to: to },
      };
    },

    // ── 스위퍼 ──

    /** 주기적 만료 정리 시작 (10초: 메시지, 60초: 비활성 에이전트) */
    startSweeper() {
      if (sweepTimer) return;
      sweepTimer = setInterval(() => {
        try { store.sweepExpired(); } catch { /* 무시 */ }
      }, 10000);
      staleTimer = setInterval(() => {
        try { store.sweepStaleAgents(); } catch { /* 무시 */ }
      }, 120000);
      sweepTimer.unref();
      staleTimer.unref();
    },

    /** 정리 중지 */
    stopSweeper() {
      if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
      if (staleTimer) { clearInterval(staleTimer); staleTimer = null; }
    },

    // ── 상태 조회 ──

    /**
     * 허브/에이전트/큐/트레이스 상태 조회
     * @param {'hub'|'agent'|'queue'|'trace'} scope
     */
    getStatus(scope = 'hub', { agent_id, trace_id, include_metrics = true } = {}) {
      const data = {};

      if (scope === 'hub' || scope === 'queue') {
        data.hub = {
          state: 'healthy',
          uptime_ms: process.uptime() * 1000 | 0,
          db_wal_mode: true,
        };
        if (include_metrics) {
          const depths = store.getQueueDepths();
          const stats = store.getDeliveryStats();
          data.queues = {
            urgent_depth: depths.urgent,
            normal_depth: depths.normal,
            dlq_depth: depths.dlq,
            avg_delivery_ms: stats.avg_delivery_ms,
          };
        }
      }

      if (scope === 'agent' && agent_id) {
        const agent = store.getAgent(agent_id);
        if (agent) {
          data.agent = {
            agent_id: agent.agent_id,
            status: agent.status,
            pending: 0,
            last_seen_ms: agent.last_seen_ms,
          };
        }
      }

      if (scope === 'trace' && trace_id) {
        data.trace = store.getMessagesByTrace(trace_id);
      }

      return { ok: true, data };
    },
  };

  return { ...router, responseEmitter };
}
