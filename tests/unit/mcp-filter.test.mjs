import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMcpPolicy,
  getCodexConfigOverrides,
  resolveMcpProfile,
  resolveSearchToolOrder,
} from '../../scripts/lib/mcp-filter.mjs';

describe('mcp-filter', () => {
  it('auto 프로필은 역할에 따라 role profile로 해석된다', () => {
    assert.equal(resolveMcpProfile('executor', 'auto'), 'executor');
    assert.equal(resolveMcpProfile('designer', 'auto'), 'designer');
    assert.equal(resolveMcpProfile('explore', 'auto'), 'explore');
    assert.equal(resolveMcpProfile('code-reviewer', 'auto'), 'reviewer');
    assert.equal(resolveMcpProfile('writer', 'auto'), 'writer');
    assert.equal(resolveMcpProfile('spark', 'auto'), 'default');
  });

  it('legacy 프로필 별칭은 새 role profile로 정규화된다', () => {
    assert.equal(resolveMcpProfile('executor', 'implement'), 'executor');
    assert.equal(resolveMcpProfile('analyst', 'analyze'), 'explore');
    assert.equal(resolveMcpProfile('code-reviewer', 'review'), 'reviewer');
    assert.equal(resolveMcpProfile('writer', 'docs'), 'writer');
    assert.equal(resolveMcpProfile('spark', 'minimal'), 'default');
  });

  it('explore 프로필은 읽기/검색 계열 서버만 허용하고 playwright는 제외한다', () => {
    const policy = buildMcpPolicy({
      agentType: 'explore',
      requestedProfile: 'explore',
      availableServers: ['context7', 'brave-search', 'exa', 'tavily', 'playwright', 'sequential-thinking'],
      workerIndex: 2,
    });

    assert.deepEqual(policy.allowedServers, ['context7', 'brave-search', 'tavily', 'exa']);
    assert.match(policy.hint, /웹 검색 우선순위: tavily, exa, brave-search\./);
  });

  it('executor 프로필은 코드 구현 문맥에서 context7 + exa로 축소된다', () => {
    const policy = buildMcpPolicy({
      agentType: 'executor',
      requestedProfile: 'auto',
      availableServers: ['context7', 'brave-search', 'exa', 'tavily', 'playwright'],
      taskText: 'Implement CLI parser, fix failing unit test, and check the package API docs.',
    });

    assert.deepEqual(policy.allowedServers, ['context7', 'exa']);
    assert.equal(policy.codexConfig.mcp_servers.playwright.enabled, false);
    assert.equal(policy.codexConfig.mcp_servers.tavily.enabled, false);
  });

  it('designer 프로필은 브라우저/UI 문맥에서 playwright를 남기고 일반 검색 서버를 줄인다', () => {
    const policy = buildMcpPolicy({
      agentType: 'designer',
      requestedProfile: 'auto',
      availableServers: ['context7', 'brave-search', 'exa', 'tavily', 'playwright'],
      taskText: 'Capture a browser screenshot and inspect responsive UI layout regression.',
    });

    assert.deepEqual(policy.allowedServers, ['context7', 'playwright']);
    assert.match(policy.hint, /playwright를 우선 사용하세요/);
  });

  it('reviewer 프로필은 분석용 도구와 문서 조회만 남긴다', () => {
    const policy = buildMcpPolicy({
      agentType: 'code-reviewer',
      requestedProfile: 'reviewer',
      availableServers: ['context7', 'brave-search', 'exa', 'tavily', 'sequential-thinking'],
    });

    assert.deepEqual(policy.geminiAllowedServers, ['context7', 'brave-search', 'sequential-thinking']);
    assert.equal(policy.codexConfig.mcp_servers['playwright'].enabled, false);
    assert.deepEqual(
      policy.codexConfig.mcp_servers['sequential-thinking'].enabled_tools,
      ['sequentialthinking'],
    );
  });

  it('codex override 플래그는 비허용 서버를 disabled=false가 아닌 enabled=false로 차단한다', () => {
    const overrides = getCodexConfigOverrides({
      agentType: 'writer',
      requestedProfile: 'writer',
      availableServers: ['context7', 'brave-search', 'exa', 'tavily'],
    });

    assert.ok(overrides.includes('mcp_servers.context7.enabled=true'));
    assert.ok(overrides.includes('mcp_servers.exa.enabled_tools=["web_search_exa"]'));
    assert.ok(overrides.includes('mcp_servers.tavily.enabled=false'));
  });

  it('search server top-k 정렬은 inventory tool_count를 tie-break에 사용한다', () => {
    const ordered = resolveSearchToolOrder(
      '',
      undefined,
      ['brave-search', 'exa'],
      'search and find the relevant result quickly.',
      {
        inventory: {
          codex: {
            servers: [
              { name: 'brave-search', tool_count: 1, domain_tags: ['search'] },
              { name: 'exa', tool_count: 7, domain_tags: ['search'] },
            ],
          },
        },
      },
    );

    assert.deepEqual(ordered, ['brave-search', 'exa']);
  });

  it('hint와 allowed server는 동일한 keyword top-k 결과를 재사용한다', () => {
    const policy = buildMcpPolicy({
      agentType: 'executor',
      requestedProfile: 'executor',
      availableServers: ['context7', 'brave-search', 'exa', 'tavily'],
      taskText: 'Verify the latest pricing status and current release announcement.',
    });

    assert.deepEqual(policy.allowedServers, ['context7', 'tavily', 'brave-search']);
    assert.match(policy.hint, /웹 검색 우선순위: tavily, brave-search\./);
  });
});
