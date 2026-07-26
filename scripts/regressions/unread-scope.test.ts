import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  countsTowardUnread,
  hasUnreadAttention,
  totalUnread,
} from '../../apps/web/src/lib/unread';

/**
 * issue #134：隐藏一个有未读的会话之后，任务栏红标和托盘闪烁就再也下不去了。
 * 它不在会话列表里，用户没有任何入口去点开它、把它读掉。
 */
test('已隐藏的会话不进任何未读提醒——点不到就清不掉', () => {
  const subscriptions = {
    hidden: { open: false, unread: 3, alert: true },
    visible: { open: true, unread: 2, alert: true },
  };

  assert.equal(totalUnread(subscriptions), 2);
  assert.equal(countsTowardUnread(subscriptions.hidden), false);
  assert.equal(hasUnreadAttention({ hidden: subscriptions.hidden }), false);
});

test('免打扰的会话同样不进提醒，但没表态过的会话要算', () => {
  assert.equal(totalUnread({ muted: { disableNotifications: true, unread: 5 } }), 0);
  // open 缺省表示服务端没给这个字段，不能当成「已隐藏」
  assert.equal(totalUnread({ plain: { unread: 4 } }), 4);
});

test('没有条数但需要注意的会话进红点，不进数字角标', () => {
  const subscriptions = { mention: { unread: 0, alert: true } };
  assert.equal(totalUnread(subscriptions), 0);
  assert.equal(hasUnreadAttention(subscriptions), true);
});

/**
 * 口径散在五个界面里各写一遍时，只有侧边栏记得跳过已隐藏的会话，
 * 于是同一时刻侧边栏说没有未读、任务栏顶着红标。加新的提醒出口时
 * 必须复用 lib/unread，不能再手写条件。
 */
test('各个提醒出口都从 lib/unread 取口径，不自己数', () => {
  const surfaces = [
    'apps/web/src/pages/MainPage.tsx',
    'apps/web/src/pages/WorkbenchPage.tsx',
    'apps/web/src/components/NavRail.tsx',
    'apps/web/src/lib/tray.ts',
  ];
  const offenders = surfaces.filter((file) => {
    const source = readFileSync(file, 'utf8');
    const usesShared = /from '\.\.?\/(?:lib\/)?unread'/.test(source);
    // 自己遍历 subscriptions 累加未读 = 又开了一份口径
    const rollsItsOwn = /disableNotifications \? 0 :|\.unread \|\| 0/.test(source);
    return !usesShared || rollsItsOwn;
  });
  assert.deepEqual(offenders, [], `这些界面又自己数未读了：\n${offenders.join('\n')}`);
});
