import assert from 'node:assert/strict';
import test from 'node:test';
import type { RcMessage } from '../../packages/rc-client/src/index';
import {
  chooseAvailableSearchTab,
  QUICK_SEARCH_TABS,
  searchMessagesGlobal,
  searchesSettledFor,
} from '../../apps/web/src/lib/quickSearch';
import { searchWork } from '../../apps/web/src/lib/workSearch';
import type { Todo } from '../../apps/web/src/stores/todos';
import type { CalendarEvent } from '../../apps/web/src/stores/calendar';
import type { WorkItem } from '../../apps/web/src/stores/workbench';

const message = (id: string) => ({ _id: id } as RcMessage);

test('全局消息搜索的合法空结果不会触发逐房间回退', async () => {
  let roomCalls = 0;
  const result = await searchMessagesGlobal('nothing', ['a', 'b'], {
    global: async () => ({ message: { docs: [] } }),
    room: async () => {
      roomCalls++;
      return [];
    },
  });

  assert.deepEqual(result, []);
  assert.equal(roomCalls, 0);
});

test('全局搜索不可用时逐房间回退并发不超过 2', async () => {
  let active = 0;
  let maxActive = 0;
  const result = await searchMessagesGlobal('needle', ['a', 'b', 'c', 'd'], {
    global: async () => {
      throw new Error('global unavailable');
    },
    room: async (rid) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return [message(rid)];
    },
  });

  assert.deepEqual(result.map((item) => item._id), ['a', 'b', 'c', 'd']);
  assert.equal(maxActive, 2);
});

test('逐房间回退失败会向界面抛错而不是伪装成零命中', async () => {
  await assert.rejects(
    searchMessagesGlobal('needle', ['a'], {
      global: async () => {
        throw new Error('global unavailable');
      },
      room: async () => {
        throw new Error('429 Too Many Requests');
      },
    }),
    /429/,
  );
});

test('过期查询不会在全局搜索失败后继续发起回退请求', async () => {
  let roomCalls = 0;
  const result = await searchMessagesGlobal(
    'stale',
    ['a', 'b'],
    {
      global: async () => {
        throw new Error('global unavailable');
      },
      room: async () => {
        roomCalls++;
        return [];
      },
    },
    () => false,
  );

  assert.deepEqual(result, []);
  assert.equal(roomCalls, 0);
});

test('自动切换保留用户当前有结果的范围，只在当前范围为空时兜底', () => {
  assert.deepEqual(QUICK_SEARCH_TABS, ['all', 'convs', 'messages', 'files', 'contacts', 'work']);
  assert.equal(searchesSettledFor('new', 'old', 'old'), false);
  assert.equal(searchesSettledFor('new', 'new', 'old'), false);
  assert.equal(searchesSettledFor('new', 'new', 'new'), true);
  assert.equal(
    chooseAvailableSearchTab('contacts', { all: 6, convs: 0, messages: 3, files: 0, contacts: 2, work: 1 }),
    'contacts',
  );
  assert.equal(
    chooseAvailableSearchTab('contacts', { all: 5, convs: 0, messages: 3, files: 0, contacts: 0, work: 1 }),
    'messages',
  );
  assert.equal(
    chooseAvailableSearchTab('all', { all: 4, convs: 0, messages: 3, files: 0, contacts: 0, work: 1 }),
    'all',
  );
});

test('工作搜索聚合待办、日程和 ADO 工作项，并优先标题命中', () => {
  const todo = {
    id: 't1', rid: 'r1', mid: 'm1', roomName: '项目群', excerpt: '讨论发布窗口',
    author: '张三', note: '确认清单', done: false, createdAt: 1,
  } as Todo;
  const event = {
    id: 'e1', title: '发布评审', description: '确认上线范围', date: '2026-07-18',
    allDay: true, color: '#3370ff', source: 'manual', createdAt: 2,
  } as CalendarEvent;
  const workItem = {
    id: 42, title: '修复发布阻塞', type: 'Bug', state: '活动', project: 'RocketX',
    webUrl: 'https://ado.example/workitems/42',
  } as WorkItem;

  assert.deepEqual(
    searchWork('发布', [todo], [event], [workItem]).map((result) => result.kind),
    ['event', 'workitem', 'todo'],
  );
  assert.deepEqual(searchWork('42', [todo], [event], [workItem]).map((result) => result.kind), ['workitem']);
  assert.deepEqual(searchWork('  ', [todo], [event], [workItem]), []);
});
