import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMessagePermalink } from '../../packages/rc-client/src/index';

test('公开频道/私有群用频道名组装永久链接', () => {
  assert.equal(
    buildMessagePermalink('https://rc.example', 'c', 'general-test', 'm1'),
    'https://rc.example/channel/general-test?msg=m1',
  );
  assert.equal(
    buildMessagePermalink('https://rc.example/', 'p', '研发小分队', 'm2'),
    'https://rc.example/group/研发小分队?msg=m2',
  );
});

test('DM 用 rid（房间文档没有 name），尾斜杠被归一', () => {
  assert.equal(
    buildMessagePermalink('https://rc.example///', 'd', 'rid-123', 'm3'),
    'https://rc.example/direct/rid-123?msg=m3',
  );
});

test('c/p 缺名字返回空串（宁可不给链接也不给死链），未知类型同理', () => {
  assert.equal(buildMessagePermalink('https://rc.example', 'c', '', 'm4'), '');
  assert.equal(buildMessagePermalink('https://rc.example', 'l', 'x', 'm5'), '');
});
