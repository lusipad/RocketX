import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setButlerLoopRunner, useButler } from '../../apps/web/src/stores/butler';

test('工具调用记录为过程步骤，成功/失败状态可见', async () => {
  useButler.getState().reset();
  const restore = setButlerLoopRunner(async (options) => {
    options.onEvent?.({ type: 'tool-call', toolCall: { id: 'call-1', name: 'list_pull_requests', arguments: '{}' } });
    options.onEvent?.({ type: 'tool-result', toolCallId: 'call-1', content: '[]' });
    options.onEvent?.({ type: 'tool-call', toolCall: { id: 'call-2', name: 'list_builds', arguments: '{}' } });
    options.onEvent?.({ type: 'tool-result', toolCallId: 'call-2', content: '工具执行失败：超时' });
    return { text: '查完了', messages: options.messages };
  });
  try {
    await useButler.getState().ask('看看 PR 和构建');
    const steps = useButler.getState().steps;
    assert.deepEqual(
      steps.map(({ label, status }) => ({ label, status })),
      [
        { label: '查询拉取请求', status: 'done' },
        { label: '查询构建', status: 'failed' },
      ],
    );
    // 新提问清空上一轮过程
    await useButler.getState().ask('再看一次');
    assert.equal(useButler.getState().steps.length, 2);
  } finally {
    restore();
  }
});

test('停止回答保留已生成内容，不当错误处理', async () => {
  useButler.getState().reset();
  const restore = setButlerLoopRunner(async (options) => {
    options.onEvent?.({ type: 'content', content: '已经写了一半' });
    await new Promise<never>((_, reject) => {
      options.signal?.addEventListener('abort', () =>
        reject(options.signal?.reason instanceof Error ? options.signal.reason : new Error('中止')),
      );
    });
    return { text: '', messages: options.messages };
  });
  try {
    const asking = useButler.getState().ask('写个长回答');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(useButler.getState().running, true);
    await useButler.getState().stop();
    await asking;

    const state = useButler.getState();
    assert.equal(state.running, false);
    assert.equal(state.error, null);
    assert.equal(state.lines.some((line) => line.text === '已经写了一半'), true);
  } finally {
    restore();
  }
});

test('两个管家对话表面都有停止按钮和过程展示', () => {
  for (const path of [
    'apps/web/src/components/ButlerConversation.tsx',
    'apps/web/src/components/ButlerPanel.tsx',
  ]) {
    const source = readFileSync(path, 'utf8');
    assert.match(source, /ButlerProcess/, path);
    assert.match(source, /stop/u, path);
    assert.match(source, /<Square size=/, path);
  }
  // Codex 大脑的停止走 turn/interrupt 并就地完成本轮
  const codex = readFileSync('apps/web/src/stores/butlerCodex.ts', 'utf8');
  assert.match(codex, /export async function stopButlerCodexTurn/);
  assert.match(codex, /'turn\/interrupt'/);
});
