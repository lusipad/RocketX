import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Conversation } from '../../apps/web/src/stores/chat';
import { commandCenterConversations } from '../../apps/web/src/lib/conversationView';
import { shouldRestoreDialogFocus } from '../../apps/web/src/lib/focus';
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

test('弹窗关闭时焦点已被接管就不再还原抢走', () => {
  const body = {} as Element;
  const composerInput = {} as Element;
  // 焦点落在 body（或丢失）时才把焦点还给弹窗打开前的元素
  assert.equal(shouldRestoreDialogFocus(null, body), true);
  assert.equal(shouldRestoreDialogFocus(body, body), true);
  // 选中联系人后输入框已聚焦：还原会把光标从输入框抢走（issue #87）
  assert.equal(shouldRestoreDialogFocus(composerInput, body), false);
});

test('指令中心选中联系人、会话或频道后光标进入输入框', () => {
  const switcher = readFileSync('apps/web/src/components/QuickSwitcher.tsx', 'utf8');
  const fnBody = (header: string): string => {
    const start = switcher.indexOf(header);
    assert.ok(start >= 0, `缺少 ${header}`);
    const end = switcher.indexOf('\n  };', start);
    assert.ok(end > start, `${header} 没有闭合`);
    return switcher.slice(start, end);
  };
  assert.match(fnBody('const pickConv'), /focusComposerInput\(\)/);
  assert.match(fnBody('const pickContact'), /focusComposerInput\(\)/);
  assert.match(fnBody('const openSpotlightRoom'), /focusComposerInput\(\)/);
  // 三处联系人入口（全部页、联系人页列表、键盘导航）都走同一个 pickContact
  assert.doesNotMatch(switcher, /startDM\(u(ser)?\.username\)\.then/);

  const dialog = readFileSync('apps/web/src/components/Dialog.tsx', 'utf8');
  assert.match(dialog, /shouldRestoreDialogFocus\(document\.activeElement, document\.body\)/);

  // 焦点选择器要和 Composer 的标记保持一致
  const composer = readFileSync('apps/web/src/components/Composer.tsx', 'utf8');
  assert.match(composer, /data-composer-input/);
  const focusLib = readFileSync('apps/web/src/lib/focus.ts', 'utf8');
  assert.match(focusLib, /\[data-composer-input\]/);
});
