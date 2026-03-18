// Batch 1: CORS 인증 E2E 테스트
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHubHarness } from './helpers/hub-auth-harness.mjs';

describe('hub auth CORS E2E', () => {
  it('허용된 origin(localhost)은 CORS 응답 헤더가 포함되어야 한다', async () => {
    const h = await createHubHarness();
    try {
      const res = await fetch(`${h.baseUrl}/status`, {
        headers: { Origin: 'http://localhost:3000' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:3000');
      assert.ok(res.headers.get('access-control-allow-methods')?.includes('POST'));
      assert.ok(res.headers.get('access-control-allow-headers')?.includes('Authorization'));
    } finally {
      await h.cleanupAll();
    }
  });

  it('허용되지 않은 origin은 Access-Control-Allow-Origin이 없어야 한다', async () => {
    const h = await createHubHarness();
    try {
      const res = await fetch(`${h.baseUrl}/status`, {
        headers: { Origin: 'http://evil.example.com' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('access-control-allow-origin'), null);
      // Vary: Origin은 origin 헤더 존재 시 항상 설정됨
      assert.equal(res.headers.get('vary'), 'Origin');
    } finally {
      await h.cleanupAll();
    }
  });

  it('OPTIONS preflight — 허용된 localhost origin이면 204', async () => {
    const h = await createHubHarness();
    try {
      const res = await fetch(`${h.baseUrl}/bridge/register`, {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:5173' },
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    } finally {
      await h.cleanupAll();
    }
  });

  it('OPTIONS preflight — 허용되지 않은 origin이면 403', async () => {
    const h = await createHubHarness();
    try {
      const res = await fetch(`${h.baseUrl}/bridge/register`, {
        method: 'OPTIONS',
        headers: { Origin: 'http://attacker.com' },
      });
      assert.equal(res.status, 403);
      assert.equal(res.headers.get('access-control-allow-origin'), null);
    } finally {
      await h.cleanupAll();
    }
  });

  it('401 응답에도 허용된 origin이면 CORS 헤더가 포함되어야 한다', async () => {
    const h = await createHubHarness({ token: 'cors-auth-test' });
    try {
      const res = await fetch(`${h.baseUrl}/bridge/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://127.0.0.1:8080',
        },
        body: JSON.stringify({ agent_id: 'cors-test', cli: 'codex' }),
      });
      assert.equal(res.status, 401);
      // CORS 헤더는 인증 실패와 무관하게 적용되어야 한다
      assert.equal(res.headers.get('access-control-allow-origin'), 'http://127.0.0.1:8080');
    } finally {
      await h.cleanupAll();
    }
  });
});
