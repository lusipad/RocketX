import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  BUTLER_BOUNDARY_NOTE,
  BUTLER_EXTRACT_COMMITMENTS_PROMPT,
  BUTLER_SCENE_PROMPTS,
  BUTLER_SUMMARIZE_PROMPT,
} from '../../apps/web/src/lib/butlerPrompts';
import { compileButlerTask } from '../../apps/web/src/lib/butlerTaskContext';
import type { ButlerSurfaceContext } from '../../apps/web/src/lib/butlerContext';

function compile(input: string, context?: ButlerSurfaceContext) {
  return compileButlerTask(input, context ?? null, null, 1_000);
}

const roomContext: ButlerSurfaceContext = {
  kind: 'room',
  label: '研发群',
  detail: '用户指定的 3 条消息',
  sources: [
    { kind: 'message', id: 'm1', mid: 'm1', rid: 'room-dev', label: '研发群 · Alice：我周四补文档' },
  ],
};

const prContext: ButlerSurfaceContext = {
  kind: 'workbench',
  label: 'ADO 拉取请求',
  detail: '用户指定的 2 个拉取请求',
  sources: [
    { kind: 'pull-request', id: '101', label: 'PR #101 支付重试' },
    { kind: 'pull-request', id: '102', label: 'PR #102 超时治理' },
  ],
};

// 这两句是入口按钮写死的提问。改一个字就可能不再命中场景正则，
// 管家会先反问一轮（「要从哪个群聊提取承诺？」），用户白等。
test('「提取承诺」按钮文案命中场景，且带房间上下文时不触发澄清', () => {
  const task = compile(BUTLER_EXTRACT_COMMITMENTS_PROMPT, roomContext);
  assert.equal(task.manifest.scenario, 'extract-commitments');
  assert.equal(task.manifest.clarification.required, false);
  assert.equal(task.status, 'ready');

  // 没有房间上下文时才应该追问——证明上面的「不追问」是上下文带来的，不是恒真
  const withoutRoom = compile(BUTLER_EXTRACT_COMMITMENTS_PROMPT);
  assert.equal(withoutRoom.manifest.scenario, 'extract-commitments');
  assert.deepEqual(withoutRoom.manifest.clarification.missing, ['群聊范围']);
  assert.equal(withoutRoom.status, 'awaiting-clarification');
});

test('PR 比较例句命中场景，且带两个 PR 来源时不触发澄清', () => {
  const comparePrompt = BUTLER_SCENE_PROMPTS.find((item) => item.scene === '比较 PR')?.prompt;
  assert.ok(comparePrompt);
  const task = compile(comparePrompt, prContext);
  assert.equal(task.manifest.scenario, 'compare-pull-requests');
  assert.equal(task.manifest.clarification.required, false);
  assert.equal(task.status, 'ready');
});

test('PR 卡片入口的提问不会被误判成「比较」而追问第二个编号', () => {
  const single = compile('看看这个 PR：改动重点、风险、我该先看哪里。PR 编号 101。', {
    kind: 'workbench',
    label: 'ADO 拉取请求',
    detail: '用户指定的 1 个拉取请求',
    sources: [{ kind: 'pull-request', id: '101', label: 'PR #101 支付重试' }],
  });
  assert.notEqual(single.manifest.scenario, 'compare-pull-requests');
  assert.equal(single.status, 'ready');
});

test('总结例句与场景例句形状稳定，边界声明说清只读与先问', () => {
  assert.ok(BUTLER_SUMMARIZE_PROMPT.trim().length > 0);
  assert.equal(BUTLER_SCENE_PROMPTS.length >= 4, true);
  for (const item of BUTLER_SCENE_PROMPTS) {
    assert.ok(item.scene.trim(), '每条例句要有场景标签');
    assert.ok(item.prompt.trim().length > 6, '例句要是一句完整的问话');
  }
  assert.match(BUTLER_BOUNDARY_NOTE, /只读|先问/);
});

test('两个入口都用共享常量，不在组件里另写一份文案', () => {
  const messageList = readFileSync('apps/web/src/components/MessageList.tsx', 'utf8');
  assert.match(messageList, /BUTLER_EXTRACT_COMMITMENTS_PROMPT/);
  assert.match(messageList, /BUTLER_SUMMARIZE_PROMPT/);
  assert.doesNotMatch(messageList, /提取这些消息里的承诺/, '文案应只存在于 butlerPrompts.ts');
});
