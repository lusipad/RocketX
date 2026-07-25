import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  BUTLER_BOUNDARY_NOTE,
  BUTLER_EXTRACT_COMMITMENTS_PROMPT,
  BUTLER_SCENE_PROMPTS,
  BUTLER_SUMMARIZE_PROMPT,
} from '../../apps/web/src/lib/butlerPrompts';
import { createMemoryBackend, createRcxStore } from '@rcx/rcx-store';
import { compileButlerTask } from '../../apps/web/src/lib/butlerTaskContext';
import type { ButlerSurfaceContext } from '../../apps/web/src/lib/butlerContext';
import { askButlerAboutMessages } from '../../apps/web/src/kernel/butler';
import {
  resetButlerPersistenceForTests,
  setButlerLoopRunner,
  setButlerPersistence,
  useButler,
} from '../../apps/web/src/stores/butler';
import { useAuth } from '../../apps/web/src/stores/auth';
import { useChat } from '../../apps/web/src/stores/chat';

const appData = createRcxStore({ backend: createMemoryBackend() }).appData;
const restorePersistence = setButlerPersistence(appData);
test.after(() => restorePersistence());

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

test('入口发出的完整正文（提问 + 转录）不会被消息内容劫持场景', () => {
  // 对抗审查实测复现过：转录里出现「查一下那个文档」会命中 find-file，
  // 场景变成 awaiting-clarification，管家反问「请补充发送人」，整轮空转。
  const transcript = [
    '[07-25 09:00] Alice：帮我查下昨天发的设计稿',
    '[07-25 09:05] Bob：我周四之前把接口文档补上',
  ].join('\n');
  const fullText = `${BUTLER_EXTRACT_COMMITMENTS_PROMPT}\n\n以下是「研发群」里指定的消息：\n${transcript}`;

  // 不传 intent（旧行为）：确实会被劫持——这条断言证明上面的防护不是恒真
  const hijacked = compile(fullText, roomContext);
  assert.equal(hijacked.manifest.scenario, 'find-file');
  assert.equal(hijacked.status, 'awaiting-clarification');

  // 入口的真实调用形态：分类只吃意图句
  const guarded = compileButlerTask(BUTLER_EXTRACT_COMMITMENTS_PROMPT, roomContext, null, 1_000);
  assert.equal(guarded.manifest.scenario, 'extract-commitments');
  assert.equal(guarded.status, 'ready');
});

test('真实入口：转录含找文件关键词时，场景仍是提取承诺且不追问', async () => {
  const restoreRunner = setButlerLoopRunner(async (options) => ({
    text: '好的',
    messages: options.messages,
  }));
  try {
    resetButlerPersistenceForTests();
    useButler.getState().reset();
    useAuth.setState({ user: { _id: 'entry-user', username: 'entry' } as never });
    useChat.setState({
      subscriptions: { 'room-dev': { rid: 'room-dev', fname: '研发群', name: 'dev', t: 'c' } },
      rooms: { 'room-dev': { _id: 'room-dev', fname: '研发群', name: 'dev', t: 'c' } },
      messages: {},
      activeRid: 'room-dev',
    } as never);
    await useButler.getState().hydrate();

    const result = askButlerAboutMessages(
      'room-dev',
      [
        { _id: 'm1', rid: 'room-dev', msg: '帮我查下昨天发的设计稿', ts: '2026-07-25T01:00:00.000Z', u: { _id: 'a', username: 'alice', name: 'Alice' } },
        { _id: 'm2', rid: 'room-dev', msg: '我周四之前把接口文档补上', ts: '2026-07-25T01:05:00.000Z', u: { _id: 'b', username: 'bob', name: 'Bob' } },
      ] as never,
      BUTLER_EXTRACT_COMMITMENTS_PROMPT,
    );
    assert.equal(result, 'asked');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = useButler.getState();
    assert.equal(state.taskState?.manifest.scenario, 'extract-commitments');
    assert.notEqual(state.taskState?.status, 'awaiting-clarification');
    // 反问句不该出现在对话里
    assert.equal(state.lines.some((item) => item.text.includes('请补充发送人')), false);
    // 转录仍然完整送达（正文里带发言人与原话）
    assert.equal(state.lines.some((item) => item.text.includes('Bob：我周四之前把接口文档补上')), true);
  } finally {
    restoreRunner();
    resetButlerPersistenceForTests();
    useButler.getState().reset();
  }
});

test('两个入口都用共享常量，不在组件里另写一份文案', () => {
  const messageList = readFileSync('apps/web/src/components/MessageList.tsx', 'utf8');
  assert.match(messageList, /BUTLER_EXTRACT_COMMITMENTS_PROMPT/);
  assert.match(messageList, /BUTLER_SUMMARIZE_PROMPT/);
  assert.doesNotMatch(messageList, /提取这些消息里的承诺/, '文案应只存在于 butlerPrompts.ts');
});
