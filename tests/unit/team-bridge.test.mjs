import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createPipeServer } from '../../hub/pipe.mjs';
import { registerTeamBridge, getTeamBridge } from '../../hub/team-bridge.mjs';
import { createTools } from '../../hub/tools.mjs';

function withBridge(bridge, fn) {
  const previous = getTeamBridge();
  registerTeamBridge(bridge);
  return Promise.resolve()
    .then(fn)
    .finally(() => registerTeamBridge(previous));
}

function parseToolResult(result) {
  return JSON.parse(result.content[0].text);
}

describe('team-bridge', () => {
  it('registerTeamBridge/getTeamBridge roundtrip을 제공해야 한다', async () => {
    const fakeBridge = {
      teamInfo: async () => ({ ok: true, data: { fake: 'info' } }),
      teamTaskList: async () => ({ ok: true, data: { tasks: [] } }),
      teamTaskUpdate: async () => ({ ok: true, data: { updated: true } }),
      teamSendMessage: async () => ({ ok: true, data: { sent: true } }),
    };

    await withBridge(fakeBridge, async () => {
      assert.equal(getTeamBridge(), fakeBridge);
    });
  });

  it('tools는 bridge가 없을 때 team 도구를 graceful fallback 해야 한다', async () => {
    await withBridge(null, async () => {
      const tools = createTools({}, {}, {}, null);
      const teamInfo = tools.find((tool) => tool.name === 'team_info');
      const teamTaskList = tools.find((tool) => tool.name === 'team_task_list');
      const teamTaskUpdate = tools.find((tool) => tool.name === 'team_task_update');
      const teamSendMessage = tools.find((tool) => tool.name === 'team_send_message');

      assert.deepEqual(
        parseToolResult(await teamInfo.handler({ team_name: 'no-team', include_members: true, include_paths: true })),
        {
          ok: true,
          data: {
            team: { team_name: 'no-team', description: null },
            lead: { lead_agent_id: null, lead_session_id: null },
            members: [],
            paths: {
              config_path: null,
              tasks_dir: null,
              inboxes_dir: null,
              tasks_dir_resolution: 'bridge_not_registered',
            },
            bridge_installed: false,
            skipped: true,
          },
        },
      );

      assert.deepEqual(
        parseToolResult(await teamTaskList.handler({ team_name: 'no-team' })),
        {
          ok: true,
          data: {
            tasks: [],
            count: 0,
            parse_warnings: 0,
            tasks_dir: null,
            tasks_dir_resolution: 'bridge_not_registered',
            bridge_installed: false,
            skipped: true,
          },
        },
      );

      assert.deepEqual(
        parseToolResult(await teamTaskUpdate.handler({ team_name: 'no-team', task_id: 'task-1' })),
        {
          ok: true,
          data: {
            claimed: false,
            updated: false,
            task_before: null,
            task_after: null,
            task_file: null,
            task_id: 'task-1',
            mtime_ms: null,
            bridge_installed: false,
            skipped: true,
          },
        },
      );

      assert.deepEqual(
        parseToolResult(await teamSendMessage.handler({ team_name: 'no-team', to: 'team-lead' })),
        {
          ok: true,
          data: {
            message_id: null,
            recipient: 'team-lead',
            inbox_file: null,
            queued_at: null,
            unread_count: 0,
            bridge_installed: false,
            skipped: true,
          },
        },
      );
    });
  });

  it('pipe는 bridge가 없을 때 team query/command를 graceful fallback 해야 한다', async () => {
    await withBridge(null, async () => {
      const pipe = createPipeServer({
        router: {
          deliveryEmitter: {
            on() {},
            off() {},
          },
        },
      });

      const info = await pipe.executeQuery('team_info', {
        team_name: 'no-team',
        include_members: true,
        include_paths: true,
      });
      assert.deepEqual(info, {
        ok: true,
        data: {
          team: { team_name: 'no-team', description: null },
          lead: { lead_agent_id: null, lead_session_id: null },
          members: [],
          paths: {
            config_path: null,
            tasks_dir: null,
            inboxes_dir: null,
            tasks_dir_resolution: 'bridge_not_registered',
          },
          bridge_installed: false,
          skipped: true,
        },
      });

      const update = await pipe.executeCommand('team_task_update', {
        team_name: 'no-team',
        task_id: 'task-2',
      });
      assert.deepEqual(update, {
        ok: true,
        data: {
          claimed: false,
          updated: false,
          task_before: null,
          task_after: null,
          task_file: null,
          task_id: 'task-2',
          mtime_ms: null,
          bridge_installed: false,
          skipped: true,
        },
      });
    });
  });
});
