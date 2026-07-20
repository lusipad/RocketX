import assert from 'node:assert/strict';
import test from 'node:test';
import {
  butlerContextPrompt,
  extractButlerSources,
  mergeButlerSources,
  type ButlerSurfaceContext,
} from '../../apps/web/src/lib/butlerContext';

test('Butler 工具结果转成有界、可导航且去重的来源', () => {
  const messages = extractButlerSources('search_messages', JSON.stringify([
    { _id: 'm1', rid: 'r1', roomName: '发布群', sender: '张三', text: '构建失败了' },
    { _id: 'm1', rid: 'r1', roomName: '发布群', sender: '张三', text: '重复结果' },
  ]));
  const workItems = extractButlerSources('list_work_items', JSON.stringify([
    { id: 105, title: '修复交接', project: 'RocketX', webUrl: 'https://ado/105' },
  ]));

  assert.deepEqual(messages, [{
    kind: 'message',
    id: 'm1',
    label: '发布群 · 张三：构建失败了',
    rid: 'r1',
    mid: 'm1',
  }]);
  assert.deepEqual(workItems, [{
    kind: 'work-item',
    id: '105',
    label: '#105 修复交接',
    project: 'RocketX',
    webUrl: 'https://ado/105',
  }]);
  assert.deepEqual(mergeButlerSources(messages, messages, workItems), [...messages, ...workItems]);
  assert.equal(extractButlerSources('search_messages', '工具执行失败：超时').length, 0);
});

test('工作面上下文只生成系统提示，并保留明确来源', () => {
  const context: ButlerSurfaceContext = {
    kind: 'room',
    label: '发布群',
    detail: '当前 Rocket.Chat 房间，共 18 条已加载消息',
    sources: [{ kind: 'room', id: 'r1', rid: 'r1', label: '发布群' }],
  };

  assert.equal(
    butlerContextPrompt(context),
    '用户当前工作面：发布群\n当前 Rocket.Chat 房间，共 18 条已加载消息\n用户当前所在房间：发布群\n查询本房间消息时优先用 search_messages 的 roomName 参数限定范围为“发布群”。',
  );
});
