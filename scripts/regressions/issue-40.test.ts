import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { RcMessage } from '../../packages/rc-client/src/types';
import { mergeMessageUpdate } from '../../apps/web/src/stores/chat';
import {
  formatTrayTooltip,
  hasTrayAttention,
} from '../../apps/web/src/lib/tray';

const message = (patch: Partial<RcMessage>): RcMessage => ({
  _id: 'message-1',
  rid: 'room-1',
  msg: '回复内容',
  ts: '2026-07-16T00:00:00.000Z',
  u: { _id: 'user-1', username: 'zhangsan' },
  ...patch,
});

test('托盘悬停提示按会话展示多个未读并限制 Windows tooltip 长度', () => {
  const tooltip = formatTrayTooltip([
    { name: '项目群', unread: 5, alert: true, muted: false },
    { name: '张三', unread: 2, alert: false, muted: false },
    { name: '免打扰群', unread: 9, alert: true, muted: true },
  ]);

  assert.match(tooltip, /2 个会话/);
  assert.match(tooltip, /7 条未读/);
  assert.match(tooltip, /项目群 5/);
  assert.match(tooltip, /张三 2/);
  assert.doesNotMatch(tooltip, /免打扰群/);
  assert.ok(tooltip.length <= 127);
});

test('关闭未读提醒后不再触发托盘闪烁', () => {
  const subscriptions = { room: { unread: 2, alert: true } };
  assert.equal(hasTrayAttention(subscriptions, true), true);
  assert.equal(hasTrayAttention(subscriptions, false), false);
});

test('服务端发送响应暂未带引用附件时保留乐观引用，避免 UI 引用消失', () => {
  const quote = {
    message_link: 'local-quote',
    author_name: '李四',
    text: '原消息',
  };
  const optimistic = message({
    msg: '[ ](http://localhost/channel/general?msg=quoted)\n回复内容',
    attachments: [quote],
    pending: true,
  });
  const confirmation = message({
    msg: '[ ](http://localhost/channel/general?msg=quoted)\n回复内容',
  });

  assert.deepEqual(mergeMessageUpdate(optimistic, confirmation).attachments, [quote]);
});

test('托盘闪烁使用保留透明通道的暗色帧，不再切换到全零透明图标', () => {
  const source = readFileSync('apps/desktop/src-tauri/src/main.rs', 'utf8');
  assert.doesNotMatch(source, /Image::new_owned\(vec!\[0;/);
  assert.match(source, /dim_tray_icon/);
});
