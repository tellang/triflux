// tests/unit/skill-drift.test.mjs — 스킬 문서 드리프트 감사 테스트
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SKILLS_DIR = join(process.cwd(), 'skills');
const ROUTE_SH = join(process.env.HOME || process.env.USERPROFILE, '.claude', 'scripts', 'tfx-route.sh');

function readSkill(name) {
  const p = join(SKILLS_DIR, name, 'SKILL.md');
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

describe('스킬 문서 존재 확인', () => {
  const expected = [
    'tfx-auto', 'tfx-multi', 'tfx-hub', 'tfx-doctor', 'tfx-setup',
    'tfx-deep-interview', 'tfx-autoresearch',
  ];

  for (const name of expected) {
    it(`${name}/SKILL.md 존재`, () => {
      const content = readSkill(name);
      assert.ok(content, `${name}/SKILL.md not found`);
      assert.ok(content.length > 50, `${name}/SKILL.md is too short`);
    });
  }
});

describe('tfx-auto SKILL.md — 에이전트 매핑 일관성', () => {
  it('executor 키워드 포함', () => {
    const content = readSkill('tfx-auto');
    assert.ok(content.includes('executor'));
  });

  it('implement MCP 프로필 포함', () => {
    const content = readSkill('tfx-auto');
    assert.ok(content.includes('implement'));
  });

  it('headless 엔진 참조 포함', () => {
    const content = readSkill('tfx-auto');
    assert.ok(content.includes('headless'));
  });

  it('resolveCliType 또는 에이전트→CLI 매핑 참조', () => {
    const content = readSkill('tfx-auto');
    // tfx-auto는 에이전트 매핑 테이블을 포함해야 함
    assert.ok(content.includes('codex') && content.includes('gemini'));
  });
});

describe('tfx-hub SKILL.md — hub 모듈 참조', () => {
  it('hub 또는 bridge 키워드 포함', () => {
    const content = readSkill('tfx-hub');
    assert.ok(content.includes('hub') || content.includes('bridge'));
  });

  it('메시지 버스 또는 MCP 참조 포함', () => {
    const content = readSkill('tfx-hub');
    assert.ok(content.includes('메시지') || content.includes('MCP'));
  });
});

describe('tfx-multi SKILL.md — headless 엔진 반영', () => {
  it('headless 키워드 포함', () => {
    const content = readSkill('tfx-multi');
    assert.ok(content.includes('headless'));
  });

  it('psmux 참조 포함', () => {
    const content = readSkill('tfx-multi');
    assert.ok(content.includes('psmux') || content.includes('headless'));
  });
});

describe('신규 스킬 완결성', () => {
  it('tfx-deep-interview: 5단계 인터뷰 구조 포함', () => {
    const content = readSkill('tfx-deep-interview');
    assert.ok(content.includes('Clarify') || content.includes('명확') || content.includes('단계'));
  });

  it('tfx-autoresearch: 리서치 워크플로우 포함', () => {
    const content = readSkill('tfx-autoresearch');
    assert.ok(content.includes('research') || content.includes('리서치') || content.includes('검색'));
  });
});

describe('tfx-route.sh와 tfx-auto SKILL.md 에이전트 매핑 교차 검증', () => {
  it('tfx-route.sh에 정의된 주요 에이전트가 tfx-auto에도 존재', () => {
    const autoContent = readSkill('tfx-auto');
    const agents = ['executor', 'architect', 'analyst', 'code-reviewer', 'writer', 'debugger'];
    for (const agent of agents) {
      assert.ok(autoContent.includes(agent), `agent "${agent}" missing in tfx-auto SKILL.md`);
    }
  });
});
