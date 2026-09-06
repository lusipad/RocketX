import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMAND_INFO,
  clientCommandList,
  parseCreateParams,
  parseMsgParams,
  parseUsernames,
  resolveClientCommand,
} from '../../apps/web/src/lib/clientCommands';
import {
  commandDesc,
  commandParams,
  nearestCommand,
} from '../../apps/web/src/lib/slash';
import { parseRoomName } from '../../apps/web/src/lib/clientCommands';
import { composerCommands } from '../../apps/web/src/kernel/dispatch';

// ---------------------------------------------------------------------------
// 纯文本类：客户端改写文本直发（服务端实现也只是改文本，绕一圈没有收益）
// ---------------------------------------------------------------------------

test('颜文字命令在客户端改写文本后直发', () => {
  const withParams = resolveClientCommand('shrug', '好吧', 'r1');
  assert.deepEqual(withParams, { type: 'send', text: '好吧 ¯\\_(ツ)_/¯' });
  const bare = resolveClientCommand('shrug', '', 'r1');
  assert.ok(bare?.type === 'send');
  assert.equal(bare.text, '¯\\_(ツ)_/¯');
  const gimme = resolveClientCommand('gimme', '抱抱', 'r1');
  assert.ok(gimme?.type === 'send');
  assert.equal(gimme.text, '༼ つ ◕_◕ ༽つ 抱抱');
});

test('/me 保持服务端转发（消息格式由服务端决定）', () => {
  assert.deepEqual(resolveClientCommand('me', '敲代码', 'r1'), { type: 'forward' });
});

// ---------------------------------------------------------------------------
// 参数化命令：一律打开 GUI，参数只作预填
// ---------------------------------------------------------------------------

test('参数化命令解析出预填值并打开对应对话框', () => {
  assert.deepEqual(resolveClientCommand('topic', '周报时间', 'r1'), {
    type: 'open',
    dialog: { kind: 'topic', rid: 'r1', prefill: '周报时间' },
  });
  assert.deepEqual(resolveClientCommand('invite', '@张三 @李四', 'r1'), {
    type: 'open',
    dialog: { kind: 'invite', rid: 'r1', prefill: '@张三 @李四' },
  });
  assert.deepEqual(resolveClientCommand('kick', '@zhang', 'r1'), {
    type: 'open',
    dialog: { kind: 'member', rid: 'r1', action: 'kick', prefill: 'zhang' },
  });
  assert.deepEqual(resolveClientCommand('join', '#dev', 'r1'), {
    type: 'open',
    dialog: { kind: 'join', prefill: 'dev' },
  });
  assert.deepEqual(resolveClientCommand('msg', '@zhang 你好呀', 'r1'), {
    type: 'open',
    dialog: { kind: 'dm', prefill: 'zhang', draft: '你好呀' },
  });
  assert.deepEqual(resolveClientCommand('invite-all-from', '#其他群', 'r1'), {
    type: 'open',
    dialog: { kind: 'roomPick', rid: 'r1', mode: 'invite-all-from' },
  });
  assert.deepEqual(resolveClientCommand('archive', '', 'r1'), {
    type: 'open',
    dialog: { kind: 'archive', rid: 'r1', archive: true },
  });
  assert.deepEqual(resolveClientCommand('unarchive', '', 'r1'), {
    type: 'open',
    dialog: { kind: 'archive', rid: 'r1', archive: false },
  });
  assert.deepEqual(resolveClientCommand('leave', '', 'r1'), {
    type: 'open',
    dialog: { kind: 'leave', rid: 'r1' },
  });
  assert.deepEqual(resolveClientCommand('status', '开会中', 'r1'), {
    type: 'open',
    dialog: { kind: 'status', prefill: '开会中' },
  });
  assert.deepEqual(resolveClientCommand('poll', '团建去哪', 'r1'), {
    type: 'open',
    dialog: { kind: 'poll', rid: 'r1', prefill: '团建去哪' },
  });
  assert.deepEqual(resolveClientCommand('kanban', '', 'r1'), {
    type: 'panel',
    panel: 'kanban',
  });
  assert.deepEqual(resolveClientCommand('oncall', '', 'r1'), {
    type: 'panel',
    panel: 'oncall',
  });
  assert.deepEqual(resolveClientCommand('help', '', 'r1'), {
    type: 'open',
    dialog: { kind: 'help' },
  });
});

test('/create 解析 --private 标记，/hide 直接执行不需要确认', () => {
  const priv = resolveClientCommand('create', 'myroom --private', 'r1');
  assert.deepEqual(priv, {
    type: 'open',
    dialog: { kind: 'create', prefill: 'myroom', priv: true },
  });
  const pub = resolveClientCommand('create', '-p #另一个', 'r1');
  assert.ok(pub?.type === 'open' && pub.dialog.kind === 'create');
  assert.equal(pub.dialog.priv, true);
  assert.equal(pub.dialog.prefill, '另一个');
  assert.deepEqual(resolveClientCommand('hide', '', 'r1'), { type: 'hideConv', rid: 'r1' });
  assert.deepEqual(resolveClientCommand('no-such-command', '', 'r1'), null);
});

test('参数解析辅助函数', () => {
  assert.deepEqual(parseUsernames('@a @b，@c'), ['a', 'b', 'c']);
  assert.deepEqual(parseUsernames('没有提及'), []);
  assert.equal(parseRoomName('#dev'), 'dev');
  assert.deepEqual(parseCreateParams('名字 --private'), { name: '名字', priv: true });
  assert.deepEqual(parseCreateParams('#公开'), { name: '公开', priv: false });
  assert.deepEqual(parseMsgParams('@zhang 早'), { username: 'zhang', draft: '早' });
  assert.deepEqual(parseMsgParams(''), { username: '', draft: '' });
});

// ---------------------------------------------------------------------------
// 命令合并：客户端注册表不被服务端列表缺席拖累，同名覆盖保证口径一致
// ---------------------------------------------------------------------------

test('composerCommands 合并后客户端命令不依赖服务端列表', () => {
  const merged = composerCommands([]);
  const shrug = merged.find((c) => c.command === 'shrug');
  assert.ok(shrug, '客户端注册表里的命令必须出现');
  assert.equal(shrug.description, COMMAND_INFO.shrug.desc);
});

test('客户端注册表覆盖服务端同名命令，说明统一为规范中文', () => {
  const merged = composerCommands([
    { command: 'shrug', description: 'Slash_Shrug_Description' },
    { command: 'fancy', description: 'Do fancy things' },
  ]);
  assert.equal(merged.find((c) => c.command === 'shrug')?.description, COMMAND_INFO.shrug.desc);
  assert.equal(merged.find((c) => c.command === 'fancy')?.description, 'Do fancy things');
});

// ---------------------------------------------------------------------------
// 说明文案：永不露出 i18n 键名，兜底策略分层
// ---------------------------------------------------------------------------

test('说明兜底：键名挡掉、可读描述放行、未知命令标注服务器来源', () => {
  assert.equal(
    commandDesc({ command: 'shrug', description: 'Slash_Shrug_Description' }),
    COMMAND_INFO.shrug.desc,
  );
  assert.equal(commandDesc({ command: 'fancy', description: 'Slash_Fancy_Description' }), '服务器提供的命令');
  assert.equal(commandDesc({ command: 'fancy', description: 'Do fancy things' }), 'Do fancy things');
  assert.equal(commandDesc({ command: 'fancy' }), '服务器提供的命令');
  assert.equal(commandParams({ command: 'fancy', params: 'Fancy_Params' }), '');
});

test('命令说明全覆盖、无颜文字堆砌、官方内置命令不缺席', () => {
  const official = [
    'me', 'msg', 'shrug', 'tableflip', 'unflip', 'lennyface', 'gimme',
    'invite', 'invite-all-from', 'invite-all-to', 'kick', 'mute', 'unmute',
    'ban', 'unban', 'create', 'join', 'part', 'leave', 'hide',
    'archive', 'unarchive', 'topic', 'status', 'help',
  ];
  for (const command of official) {
    const info = COMMAND_INFO[command];
    assert.ok(info, `缺少 /${command} 的说明`);
    assert.ok(info.desc.length >= 6, `/${command} 说明太短：${info.desc}`);
    assert.doesNotMatch(info.desc, /[¯ツ┻ノ◕༼ლ°◡]/u, `/${command} 说明不应堆颜文字`);
    assert.doesNotMatch(info.desc, /^[A-Za-z][A-Za-z0-9]*(_[A-Za-z0-9]+)+$/, `/${command} 说明是 i18n 键名`);
  }
  assert.ok(clientCommandList().length >= official.length);
});

// ---------------------------------------------------------------------------
// 未知命令建议
// ---------------------------------------------------------------------------

test('nearestCommand 给打错的命令找最近似候选', () => {
  const commands = clientCommandList();
  assert.equal(nearestCommand('kic', commands), 'kick');
  assert.equal(nearestCommand('kik', commands), 'kick');
  assert.equal(nearestCommand('shrugg', commands), 'shrug');
  assert.equal(nearestCommand('zzzzzz', commands), null);
  assert.equal(nearestCommand('', commands), null);
});
