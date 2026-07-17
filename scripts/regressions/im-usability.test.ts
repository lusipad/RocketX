import assert from 'node:assert/strict';
import test from 'node:test';
import type { Conversation } from '../../apps/web/src/stores/chat';
import type { Folder } from '../../apps/web/src/stores/folders';
import { MODULE_ORDER } from '../../apps/web/src/stores/ui';
import {
  adjacentConversation,
  buildConversationView,
  flattenConversationView,
  nextUnreadConversation,
} from '../../apps/web/src/lib/conversationView';
import {
  DEFAULT_CONVERSATION_WIDTH,
  MAX_CONVERSATION_WIDTH,
  MIN_CONVERSATION_WIDTH,
  imLayoutStorageKey,
  parseImLayout,
} from '../../apps/web/src/lib/imLayout';
import { onboardingStorageKey } from '../../apps/web/src/lib/onboarding';

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function conversation(
  rid: string,
  overrides: Partial<Conversation> = {},
): Conversation {
  return {
    rid,
    name: rid,
    type: 'c',
    unread: 0,
    alert: false,
    userMentions: 0,
    favorite: false,
    muted: false,
    hidden: false,
    isDiscussion: false,
    isMultiDM: false,
    isTeam: false,
    lastTs: 0,
    lastPreview: '',
    ...overrides,
  };
}

const baseView = {
  filter: 'all' as const,
  groupByType: false,
  showUnread: false,
  showFavorites: false,
  sortBy: 'activity' as const,
};

test('模块快捷键保留执行间直达顺序', () => {
  assert.deepEqual(MODULE_ORDER, [
    'messages',
    'today',
    'todos',
    'calendar',
    'workbench',
    'contacts',
    'ai-assistant',
    'codex',
    'settings',
  ]);
});

test('快捷键只沿当前过滤后的可见会话顺序移动', () => {
  const conversations = [
    conversation('old-unread', { unread: 1, lastTs: 10 }),
    conversation('read', { lastTs: 30 }),
    conversation('new-unread', { alert: true, lastTs: 20 }),
  ];
  const sections = buildConversationView(conversations, {
    ...baseView,
    filter: 'unread',
  });
  const visible = flattenConversationView(sections, [], false);
  assert.deepEqual(visible.map((item) => item.rid), ['new-unread', 'old-unread']);
  assert.equal(adjacentConversation(visible, 'new-unread', 1)?.rid, 'old-unread');
  assert.equal(adjacentConversation(visible, 'old-unread', -1)?.rid, 'new-unread');
});

test('折叠分区和自定义分组的手工顺序会进入可见会话计算', () => {
  const conversations = [
    conversation('manual', { lastTs: 1 }),
    conversation('rule-new', { name: 'WI-new', lastTs: 30 }),
    conversation('rule-old', { name: 'WI-old', lastTs: 20 }),
    conversation('outside', { lastTs: 40 }),
  ];
  const folder: Folder = {
    id: 'work',
    name: '工作',
    rids: ['manual'],
    rules: [{ mode: 'prefix', value: 'WI-' }],
  };
  const sections = buildConversationView(conversations, { ...baseView, folder });
  assert.deepEqual(
    flattenConversationView(sections, [], false).map((item) => item.rid),
    ['manual', 'rule-new', 'rule-old'],
  );
  assert.deepEqual(flattenConversationView(sections, ['all'], true), []);
});

test('读完的当前会话暂留，切到下一条未读后可替换', () => {
  const conversations = [
    conversation('current', { lastTs: 30 }),
    conversation('next', { unread: 2, lastTs: 20 }),
    conversation('last', { alert: true, lastTs: 10 }),
  ];
  const sections = buildConversationView(conversations, {
    ...baseView,
    filter: 'unread',
    retainedUnreadRid: 'current',
  });
  assert.deepEqual(
    flattenConversationView(sections, [], false).map((item) => item.rid),
    ['current', 'next', 'last'],
  );
  assert.equal(nextUnreadConversation(conversations, 'current')?.rid, 'next');
});

test('布局状态按服务器和账号隔离，非法宽度会安全收敛', () => {
  assert.notEqual(
    imLayoutStorageKey('https://chat.example.com', 'a'),
    imLayoutStorageKey('https://chat.example.com', 'b'),
  );
  assert.equal(
    imLayoutStorageKey('HTTPS://CHAT.EXAMPLE.COM/', 'a'),
    imLayoutStorageKey('https://chat.example.com', 'a'),
  );
  assert.equal(parseImLayout(null).conversationWidth, DEFAULT_CONVERSATION_WIDTH);
  assert.equal(
    parseImLayout(JSON.stringify({ version: 1, conversationWidth: 10 })).conversationWidth,
    MIN_CONVERSATION_WIDTH,
  );
  assert.equal(
    parseImLayout(JSON.stringify({ version: 1, conversationWidth: 999 })).conversationWidth,
    MAX_CONVERSATION_WIDTH,
  );
});

test('同一用户切换服务器时会重新载入布局和引导状态', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

  try {
    storage.setItem('rcx-server', 'https://chat-a.example.com');
    storage.setItem(
      imLayoutStorageKey('https://chat-a.example.com', 'same-user'),
      JSON.stringify({ version: 1, conversationWidth: 310, groupCollapsed: false }),
    );
    storage.setItem(
      onboardingStorageKey('https://chat-a.example.com', 'same-user'),
      JSON.stringify({
        version: 1,
        ado: 'configured',
        checklist: {
          startedConversation: true,
          sentMessage: true,
          notificationsEnabled: true,
          dismissed: false,
        },
      }),
    );

    const { useImLayout } = await import('../../apps/web/src/stores/imLayout');
    const { useOnboarding } = await import('../../apps/web/src/stores/onboarding');
    useImLayout.getState().hydrate('same-user');
    useOnboarding.getState().hydrate('same-user');
    assert.equal(useImLayout.getState().layout.conversationWidth, 310);
    assert.equal(useOnboarding.getState().state?.ado, 'configured');

    storage.setItem('rcx-server', 'https://chat-b.example.com');
    storage.setItem(
      imLayoutStorageKey('https://chat-b.example.com', 'same-user'),
      JSON.stringify({ version: 1, conversationWidth: 430, groupCollapsed: true }),
    );
    storage.setItem(
      onboardingStorageKey('https://chat-b.example.com', 'same-user'),
      JSON.stringify({
        version: 1,
        ado: 'skipped',
        checklist: {
          startedConversation: false,
          sentMessage: false,
          notificationsEnabled: false,
          dismissed: true,
        },
      }),
    );
    useImLayout.getState().hydrate('same-user');
    useOnboarding.getState().hydrate('same-user');
    assert.equal(useImLayout.getState().layout.conversationWidth, 430);
    assert.equal(useImLayout.getState().layout.groupCollapsed, true);
    assert.equal(useOnboarding.getState().state?.ado, 'skipped');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
