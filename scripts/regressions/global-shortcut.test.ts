import assert from 'node:assert/strict';
import test from 'node:test';
import type { Conversation } from '../../apps/web/src/stores/chat';
import { commandCenterConversations } from '../../apps/web/src/lib/conversationView';
import {
  DEFAULT_GLOBAL_SHORTCUT,
  GLOBAL_SHORTCUT_OPTIONS,
  defaultGlobalShortcutConfig,
  parseGlobalShortcutConfig,
} from '../../apps/web/src/lib/globalShortcut';

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

test('全局指令中心空输入时只显示未读并按活跃时间排序', () => {
  const result = commandCenterConversations([
    conversation('read', { lastTs: 40 }),
    conversation('old-unread', { unread: 1, lastTs: 10 }),
    conversation('new-unread', { alert: true, lastTs: 30 }),
  ]);
  assert.deepEqual(result.map((item) => item.rid), ['new-unread', 'old-unread']);
});

test('没有未读时指令中心退回最近会话，避免空面板', () => {
  const result = commandCenterConversations([
    conversation('old', { lastTs: 10 }),
    conversation('new', { lastTs: 30 }),
  ]);
  assert.deepEqual(result.map((item) => item.rid), ['new', 'old']);
});

test('全局快捷键配置只接受受支持组合并安全回退', () => {
  assert.equal(defaultGlobalShortcutConfig().shortcut, DEFAULT_GLOBAL_SHORTCUT);
  assert.equal(GLOBAL_SHORTCUT_OPTIONS.some((item) => item.value === DEFAULT_GLOBAL_SHORTCUT), true);
  assert.deepEqual(
    parseGlobalShortcutConfig(JSON.stringify({
      version: 1,
      enabled: false,
      shortcut: 'Control+Shift+Space',
    })),
    { version: 1, enabled: false, shortcut: 'Control+Shift+Space' },
  );
  assert.deepEqual(
    parseGlobalShortcutConfig(JSON.stringify({
      version: 1,
      enabled: true,
      shortcut: 'Alt+F4',
    })),
    defaultGlobalShortcutConfig(),
  );
  assert.deepEqual(parseGlobalShortcutConfig('{broken'), defaultGlobalShortcutConfig());
});
