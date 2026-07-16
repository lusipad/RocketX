import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { RcMessage } from '../../packages/rc-client/src/index';
import {
  clearMessageSearchCache,
  chooseAvailableSearchTab,
  mergeMessageSearchResults,
  QUICK_SEARCH_RESULT_SECTIONS,
  QUICK_SEARCH_TABS,
  searchMessagesCached,
  searchMessagesGlobal,
  searchMoreMessages,
  searchLoadedMessages,
  searchesSettledFor,
  type MessageSearchPage,
} from '../../apps/web/src/lib/quickSearch';
import { searchWork } from '../../apps/web/src/lib/workSearch';
import type { Todo } from '../../apps/web/src/stores/todos';
import type { CalendarEvent } from '../../apps/web/src/stores/calendar';
import type { WorkItem } from '../../apps/web/src/stores/workbench';

const message = (id: string, time = 0) => ({ _id: id, ts: new Date(time).toISOString() } as RcMessage);
const page = (
  messages: RcMessage[],
  overrides: Partial<MessageSearchPage> = {},
): MessageSearchPage => ({
  messages,
  source: 'rooms',
  page: 0,
  hasMore: false,
  ...overrides,
});

test.afterEach(() => clearMessageSearchCache());

test('全局消息搜索的合法空结果不会触发逐房间回退', async () => {
  let roomCalls = 0;
  const result = await searchMessagesGlobal('nothing', ['a', 'b'], {
    provider: async () => ({ settings: { GlobalSearchEnabled: true } }),
    global: async () => ({ message: { docs: [] } }),
    room: async () => {
      roomCalls++;
      return [];
    },
  });

  assert.deepEqual(result, page([], { source: 'global' }));
  assert.equal(roomCalls, 0);
});

test('默认消息搜索保持当前会话范围，只有显式操作才搜索全部会话', async () => {
  const scopes: boolean[] = [];
  const backend = {
    provider: async () => ({ settings: { GlobalSearchEnabled: true } }),
    global: async (_keyword: string, _limit: number, searchAll: boolean) => {
      scopes.push(searchAll);
      return { message: { docs: [] } };
    },
    room: async () => [],
  };

  await searchMessagesGlobal('needle', ['current-room'], backend, () => true, () => {}, {
    searchAll: false,
  });
  await searchMessagesGlobal('needle', ['current-room', 'other-room'], backend, () => true, () => {}, {
    searchAll: true,
  });

  assert.deepEqual(scopes, [false, true]);
});

test('全局搜索关闭时，当前会话搜索仍使用提供器而不是触发跨会话回退', async () => {
  let roomCalls = 0;
  const result = await searchMessagesGlobal(
    'needle',
    ['current-room'],
    {
      provider: async () => ({ settings: { GlobalSearchEnabled: false } }),
      global: async (_keyword, _limit, searchAll) => {
        assert.equal(searchAll, false);
        return { message: { docs: [message('current')] } };
      },
      room: async () => {
        roomCalls++;
        return [];
      },
    },
    () => true,
    () => {},
    { searchAll: false },
  );

  assert.deepEqual(result.messages.map((item) => item._id), ['current']);
  assert.equal(roomCalls, 0);
});

test('全局搜索不可用时逐房间回退并发不超过 2', async () => {
  let active = 0;
  let maxActive = 0;
  const result = await searchMessagesGlobal('needle', ['a', 'b', 'c', 'd'], {
    provider: async () => ({ settings: { GlobalSearchEnabled: true } }),
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

  assert.deepEqual(result.messages.map((item) => item._id), ['a', 'b', 'c', 'd']);
  assert.equal(result.source, 'rooms');
  assert.equal(maxActive, 2);
});

test('逐房间回退按批次返回进度，不必等全部会话搜索完成', async () => {
  const progress: string[][] = [];
  const result = await searchMessagesGlobal(
    'needle',
    ['recent-a', 'recent-b', 'old-c'],
    {
      provider: async () => ({ settings: { GlobalSearchEnabled: false } }),
      global: async () => ({ message: { docs: [] } }),
      room: async (rid) => [message(rid)],
    },
    () => true,
    (result) => progress.push(result.messages.map((item) => item._id)),
  );

  assert.deepEqual(progress, [
    ['recent-a', 'recent-b'],
    ['recent-a', 'recent-b', 'old-c'],
  ]);
  assert.deepEqual(result.messages.map((item) => item._id), ['recent-a', 'recent-b', 'old-c']);
});

test('已加载消息先提供即时结果，并与远端结果去重合并', () => {
  const local = searchLoadedMessages('发布', {
    recent: [
      { ...message('local', 30), rid: 'recent', msg: '准备发布', file: undefined, attachments: undefined },
      { ...message('file', 20), rid: 'recent', msg: '', file: { _id: 'f1', name: '发布清单.docx' } },
    ],
    old: [
      {
        ...message('attachment', 10),
        rid: 'old',
        msg: '',
        attachments: [{ title: '发布说明' }],
      },
    ],
  });
  const merged = mergeMessageSearchResults(local, [
    { ...message('local', 30), rid: 'recent', msg: '准备发布' },
    { ...message('remote', 40), rid: 'remote', msg: '历史发布记录' },
  ]);

  assert.deepEqual(local.map((item) => item._id), ['local', 'file', 'attachment']);
  assert.deepEqual(merged.map((item) => item._id), ['remote', 'local', 'file', 'attachment']);
});

test('已退出的私有会话不会通过本机消息缓存重新出现在搜索中', () => {
  const local = searchLoadedMessages(
    '发布',
    {
      subscribed: [{ ...message('visible'), rid: 'subscribed', msg: '发布计划' }],
      departed: [{ ...message('hidden'), rid: 'departed', msg: '发布秘密' }],
    },
    (rid) => rid === 'subscribed',
  );

  assert.deepEqual(local.map((item) => item._id), ['visible']);
});

test('逐房间回退失败会向界面抛错而不是伪装成零命中', async () => {
  await assert.rejects(
    searchMessagesGlobal('needle', ['a'], {
      provider: async () => ({ settings: { GlobalSearchEnabled: true } }),
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
      provider: async () => ({ settings: { GlobalSearchEnabled: true } }),
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

  assert.deepEqual(result, page([]));
  assert.equal(roomCalls, 0);
});

test('服务端未启用全局搜索时会逐房间查找，不会把合法空结果当成最终结果', async () => {
  let globalCalls = 0;
  const rids = Array.from({ length: 10 }, (_, index) => `room-${index + 1}`);
  const result = await searchMessagesGlobal('needle', rids, {
    provider: async () => ({ settings: { GlobalSearchEnabled: false } }),
    global: async () => {
      globalCalls++;
      return { message: { docs: [] } };
    },
    room: async (rid) => rid === 'room-10' ? [message('found')] : [],
  });

  assert.deepEqual(result.messages.map((item) => item._id), ['found']);
  assert.equal(globalCalls, 0);
});

test('搜索提供器不可用时会逐房间回退', async () => {
  const result = await searchMessagesGlobal('needle', ['room-1'], {
    provider: async () => {
      throw new Error('provider unavailable');
    },
    global: async () => ({ message: { docs: [] } }),
    room: async () => [message('fallback')],
  });

  assert.deepEqual(result.messages.map((item) => item._id), ['fallback']);
});

test('未声明默认全局开关的第三方搜索提供器继续使用全局搜索', async () => {
  let roomCalls = 0;
  const result = await searchMessagesGlobal('needle', ['room-1'], {
    provider: async () => ({ settings: {} }),
    global: async () => ({ message: { docs: [message('global')] } }),
    room: async () => {
      roomCalls++;
      return [];
    },
  });

  assert.deepEqual(result.messages.map((item) => item._id), ['global']);
  assert.equal(result.source, 'global');
  assert.equal(roomCalls, 0);
});

test('逐房间回退保留各会话首批结果，供界面分段展示', async () => {
  let roomCalls = 0;
  const result = await searchMessagesGlobal(
    'needle',
    Array.from({ length: 20 }, (_, index) => `room-${index + 1}`),
    {
      provider: async () => ({ settings: { GlobalSearchEnabled: false } }),
      global: async () => ({ message: { docs: [] } }),
      room: async (rid) => {
        roomCalls++;
        const roomNumber = Number(rid.split('-')[1]);
        return Array.from(
          { length: 20 },
          (_, index) => message(`${rid}-${index}`, roomNumber * 1_000 + index),
        );
      },
    },
  );

  assert.equal(result.messages.length, 400);
  assert.equal(roomCalls, 20);
  assert.equal(result.messages[0]?._id, 'room-20-19');
  assert.equal(result.hasMore, true);
});

test('全局搜索滚动加载时扩大 limit 并返回下一批状态', async () => {
  const limits: number[] = [];
  const result = await searchMoreMessages(
    'needle',
    ['room-1'],
    'global',
    1,
    {
      provider: async () => ({ settings: { GlobalSearchEnabled: true } }),
      global: async (_keyword, limit) => {
        limits.push(limit);
        return {
          message: {
            docs: Array.from({ length: limit }, (_, index) => message(`global-${index}`, index)),
          },
        };
      },
      room: async () => [],
    },
  );

  assert.deepEqual(limits, [40]);
  assert.equal(result.messages.length, 40);
  assert.equal(result.page, 1);
  assert.equal(result.hasMore, true);
});

test('当前会话滚动加载不会把提供器调用升级为搜索全部', async () => {
  const scopes: boolean[] = [];
  await searchMoreMessages(
    'needle',
    ['current-room'],
    'global',
    1,
    {
      provider: async () => ({ settings: { GlobalSearchEnabled: false } }),
      global: async (_keyword, _limit, searchAll) => {
        scopes.push(searchAll);
        return { message: { docs: [] } };
      },
      room: async () => [],
    },
    () => true,
    () => {},
    { searchAll: false },
  );

  assert.deepEqual(scopes, [false]);
});

test('逐房间滚动加载使用 offset 获取下一页并渐进返回', async () => {
  const calls: { rid: string; offset: number; count: number }[] = [];
  const progress: string[][] = [];
  const result = await searchMoreMessages(
    'needle',
    ['room-a', 'room-b', 'room-c'],
    'rooms',
    1,
    {
      provider: async () => ({ settings: { GlobalSearchEnabled: false } }),
      global: async () => ({ message: { docs: [] } }),
      room: async (rid, _keyword, offset, count) => {
        calls.push({ rid, offset, count });
        return rid === 'room-c'
          ? []
          : Array.from({ length: count }, (_, index) => message(`${rid}-${offset + index}`));
      },
    },
    () => true,
    (partial) => progress.push(partial.messages.map((item) => item._id)),
  );

  assert.deepEqual(calls, [
    { rid: 'room-a', offset: 20, count: 20 },
    { rid: 'room-b', offset: 20, count: 20 },
    { rid: 'room-c', offset: 20, count: 20 },
  ]);
  assert.equal(progress.length, 2);
  assert.equal(result.messages.length, 40);
  assert.equal(result.page, 1);
  assert.equal(result.hasMore, true);
});

test('快捷搜索按 Rocket.Chat 契约探测提供器并显式请求全局消息', () => {
  const source = readFileSync('apps/web/src/components/QuickSwitcher.tsx', 'utf8');

  assert.match(source, /rocketchatSearch\.getProvider/);
  assert.match(source, /\{ limit, searchAll \}/);
  assert.match(source, /rest\.searchMessages\(rid, searchKeyword, count, offset\)/);
  assert.match(source, /onScroll=\{handleResultsScroll\}/);
  assert.match(source, /searchMoreMessages\(/);
  assert.match(source, /搜索全部/);
  assert.match(source, /setMessageSearchAllKeyword\(q\)/);
  assert.match(source, /shownMessages\.map/);
  assert.match(source, /conversations\.map\(\(conversation\) => conversation\.rid\)/);
  assert.match(source, /Object\.keys\(subscriptions\)\.sort\(\)\.join\('\\0'\)/);
  assert.match(source, /searchLoadedMessages\([\s\S]*useChat\.getState\(\)\.messages,[\s\S]*canSearchIndexedRoom/);
});

test('同一服务器账号和会话范围在 30 秒内复用成功搜索', async () => {
  let calls = 0;
  let now = 1_000;
  const load = async () => {
    calls++;
    return page([message(`result-${calls}`)]);
  };

  const first = await searchMessagesCached('server\0user\0rooms\0needle', load, () => true, () => now);
  now += 29_999;
  const second = await searchMessagesCached('server\0user\0rooms\0needle', load, () => true, () => now);

  assert.deepEqual(first.messages.map((item) => item._id), ['result-1']);
  assert.deepEqual(second.messages.map((item) => item._id), ['result-1']);
  assert.equal(calls, 1);
});

test('搜索缓存过期、账号变化或会话范围变化都会重新请求', async () => {
  let calls = 0;
  let now = 1_000;
  const load = async () => page([message(`result-${++calls}`)]);

  await searchMessagesCached('server\0user-a\0rooms-a\0needle', load, () => true, () => now);
  now += 30_000;
  await searchMessagesCached('server\0user-a\0rooms-a\0needle', load, () => true, () => now);
  await searchMessagesCached('server\0user-b\0rooms-a\0needle', load, () => true, () => now);
  await searchMessagesCached('server\0user-a\0rooms-b\0needle', load, () => true, () => now);

  assert.equal(calls, 4);
});

test('失败和已经过期的查询结果不会写入搜索缓存', async () => {
  let calls = 0;
  await assert.rejects(
    searchMessagesCached('error', async () => {
      calls++;
      throw new Error('search failed');
    }),
    /search failed/,
  );
  await searchMessagesCached('error', async () => page([message(`result-${++calls}`)]));
  await searchMessagesCached('stale', async () => page([message(`result-${++calls}`)]), () => false);
  await searchMessagesCached('stale', async () => page([message(`result-${++calls}`)]));

  assert.equal(calls, 4);
});

test('搜索缓存最多保留 5 个最近使用的查询，避免分页结果放大内存占用', async () => {
  let calls = 0;
  const load = async () => page([message(`result-${++calls}`)]);
  for (let index = 0; index < 6; index++) {
    await searchMessagesCached(`key-${index}`, load);
  }

  await searchMessagesCached('key-0', load);
  await searchMessagesCached('key-5', load);

  assert.equal(calls, 7);
});

test('逐房间首批结果过大时不写入跨查询缓存', async () => {
  let calls = 0;
  const load = async () => {
    calls++;
    return page(Array.from({ length: 201 }, (_, index) => message(`result-${index}`)));
  };

  await searchMessagesCached('large-result', load);
  await searchMessagesCached('large-result', load);

  assert.equal(calls, 2);
});

test('自动切换保留用户当前有结果的范围，只在当前范围为空时兜底', () => {
  assert.deepEqual(QUICK_SEARCH_TABS, ['all', 'convs', 'messages', 'files', 'contacts', 'work']);
  assert.deepEqual(QUICK_SEARCH_RESULT_SECTIONS, ['contacts', 'convs', 'messages', 'files', 'work']);
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
