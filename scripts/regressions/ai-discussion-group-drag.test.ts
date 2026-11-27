import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRoomAiParticipantPrompt,
  extractRoomParticipantInstruction,
  formatHostedRoomAiReply,
  handleRoomAiParticipantMessage,
  setRoomAiButlerRunner,
  startRoomAiParticipantBridge,
} from '../../apps/web/src/agent/roomAiParticipantRuntime';
import {
  AI_PARTICIPANT_MIME,
  formatAiDiscussionHandoffDraft,
  hasAiParticipantDrag,
  readAiParticipantDrag,
  writeAiParticipantDrag,
} from '../../apps/web/src/lib/butlerChatBridge';
import { parseHostedAgentAnswer } from '../../apps/web/src/lib/hostedAgentAnswer';
import { useAuth } from '../../apps/web/src/stores/auth';
import { useButlerSkills } from '../../apps/web/src/stores/butlerSkills';
import { useChat } from '../../apps/web/src/stores/chat';
import { useCodexWorkspace } from '../../apps/web/src/stores/codexWorkspace';
import { useRoomAiParticipants } from '../../apps/web/src/stores/roomAiParticipants';

function installMemoryStorage(): void {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
  };
}

function createMockDataTransfer(): DataTransfer {
  const bag = new Map<string, string>();
  return {
    dropEffect: 'none',
    effectAllowed: 'none',
    get types() {
      return [...bag.keys()];
    },
    setData: (mime: string, value: string) => {
      bag.set(mime, value);
    },
    getData: (mime: string) => bag.get(mime) ?? '',
  } as unknown as DataTransfer;
}

function resetTestEnv(): Array<{ text: string; rid: string; tmid?: string }> {
  installMemoryStorage();
  setRoomAiButlerRunner(null);
  const sentMessages: Array<{ text: string; rid: string; tmid?: string }> = [];

  useAuth.setState({
    user: { _id: 'u-alice', username: 'alice', name: 'Alice' } as never,
    localMode: false,
  });
  useCodexWorkspace.setState({
    workspaceRoot: 'd:/Repos/rocketchatx',
    butlerWorkspaceRoot: 'd:/Repos/rocketchatx-butler',
    defaultWorkspaceRoot: 'd:/Repos/rocketchatx',
    status: 'ready',
  });
  useButlerSkills.setState({
    accountScope: 'u-alice@same-origin',
    skills: [],
    hydrated: true,
    loading: false,
    error: null,
  });
  useRoomAiParticipants.setState({
    accountScope: 'u-alice@same-origin',
    hydrated: true,
    participants: {},
  });
  useChat.setState({
    subscriptions: {
      'disc-ai-1': { rid: 'disc-ai-1', prid: 'grp-dev', t: 'p', name: 'ai-plan', fname: 'AI 架构讨论组' } as never,
      'grp-regular': { rid: 'grp-regular', t: 'p', name: 'release-chat', fname: '发版协同群' } as never,
    },
    rooms: {
      'disc-ai-1': { _id: 'disc-ai-1', prid: 'grp-dev', t: 'p', name: 'ai-plan', fname: 'AI 架构讨论组' } as never,
      'grp-regular': { _id: 'grp-regular', t: 'p', name: 'release-chat', fname: '发版协同群' } as never,
    },
    messages: {
      'disc-ai-1': [],
      'grp-regular': [],
    },
    send: async (text, opts) => {
      const rid = opts?.rid ?? 'grp-regular';
      const entry = { text, rid, tmid: opts?.tmid };
      sentMessages.push(entry);
      const nextMsg = {
        _id: `bot-${sentMessages.length}`,
        rid,
        tmid: opts?.tmid,
        msg: text,
        ts: new Date().toISOString(),
        u: { _id: 'u-alice', username: 'alice', name: 'Alice' },
      };
      useChat.setState((state) => ({
        messages: {
          ...state.messages,
          [rid]: [...(state.messages[rid] ?? []), nextMsg as never],
        },
      }));
      return { delivery: 'server', message: nextMsg } as never;
    },
  });

  return sentMessages;
}

test('AI 讨论组：每条消息无需 @ 直接回复、保存线程上下文并防止机器人自激回环', async () => {
  const sent = resetTestEnv();
  const seenThreadIds: Array<string | undefined> = [];

  setRoomAiButlerRunner(async ({ participant, instruction }) => {
    seenThreadIds.push(participant.threadId);
    return {
      text: `已收到并处理：${instruction}`,
      threadId: 'thread-butler-99',
    };
  });

  const participant = useRoomAiParticipants.getState().enrollRoom({
    rid: 'disc-ai-1',
    isDiscussion: true,
    agentKind: 'pi_butler',
    agentId: 'pi_butler',
    agentName: 'Pi 管家',
  });
  assert.equal(participant.replyPolicy, 'every_message');

  const stop = startRoomAiParticipantBridge();
  try {
    useChat.setState((state) => ({
      messages: {
        ...state.messages,
        'disc-ai-1': [
          {
            _id: 'm-1',
            rid: 'disc-ai-1',
            msg: '帮我梳理本周待拍板项',
            ts: new Date('2026-11-26T10:00:00Z').toISOString(),
            u: { _id: 'u-alice', username: 'alice', name: 'Alice' },
          } as never,
        ],
      },
    }));

    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].rid, 'disc-ai-1');
    assert.match(sent[0].text, /^🤖 Pi 管家（[^）]+）\n已收到并处理：帮我梳理本周待拍板项/u);

    // 二轮继续发送：应带出第一轮返回的 threadId，且不会因为上面写回的 `🤖 Pi 管家...` 消息触发自激循环
    useChat.setState((state) => ({
      messages: {
        ...state.messages,
        'disc-ai-1': [
          ...(state.messages['disc-ai-1'] ?? []),
          {
            _id: 'm-2',
            rid: 'disc-ai-1',
            msg: '再补充检查一下回归测试状态',
            ts: new Date('2026-11-26T10:01:00Z').toISOString(),
            u: { _id: 'u-alice', username: 'alice', name: 'Alice' },
          } as never,
        ],
      },
    }));

    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sent.length, 2);
    assert.deepEqual(seenThreadIds, [undefined, 'thread-butler-99']);
  } finally {
    stop();
    setRoomAiButlerRunner(null);
  }
});

test('拖入普通群聊：保留原讨论组上下文并默认切换为仅 @ai/@管家 触发', async () => {
  const sent = resetTestEnv();
  const capturedPrompts: string[] = [];

  setRoomAiButlerRunner(async ({ prompt, instruction }) => {
    capturedPrompts.push(prompt);
    return {
      text: `群内响应：${instruction}`,
      threadId: 'thread-butler-99',
    };
  });

  // 源 AI 讨论组里已有历史消息
  useChat.setState((state) => ({
    messages: {
      ...state.messages,
      'disc-ai-1': [
        {
          _id: 'orig-1',
          rid: 'disc-ai-1',
          msg: '方案 A：先在灰度验证热加载，确认无误再放全量',
          ts: new Date('2026-11-26T09:00:00Z').toISOString(),
          u: { _id: 'u-alice', username: 'alice', name: 'Alice' },
        } as never,
      ],
    },
  }));

  // 构造拖拽载荷并经过 DataTransfer 往返校验
  const dt = createMockDataTransfer();
  writeAiParticipantDrag(dt, {
    source: 'ai_discussion',
    agentKind: 'pi_butler',
    agentId: 'pi_butler',
    agentName: 'Pi 管家',
    discussionRid: 'disc-ai-1',
    discussionName: 'AI 架构讨论组',
    threadId: 'thread-butler-99',
    workspaceRoot: 'd:/Repos/rocketchatx-butler',
    summary: '灰度热加载方案已确认',
  });
  assert.equal(hasAiParticipantDrag(dt), true);
  assert.ok(dt.types.includes(AI_PARTICIPANT_MIME));
  const payload = readAiParticipantDrag(dt);
  assert.ok(payload);

  const handoffDraft = formatAiDiscussionHandoffDraft(payload);
  assert.match(handoffDraft, /AI 架构讨论组/);

  // 拖入普通群聊 grp-regular（isDiscussion = false）
  const enrolled = useRoomAiParticipants.getState().enrollFromDrag('grp-regular', false, payload);
  assert.equal(enrolled.replyPolicy, 'mention_only');
  assert.equal(enrolled.threadId, 'thread-butler-99');
  assert.equal(enrolled.originDiscussionRid, 'disc-ai-1');

  // 普通闲聊不触发
  const casualMsg = {
    _id: 'g-1',
    rid: 'grp-regular',
    msg: '下午三点大家记得对一下发版清单',
    ts: new Date('2026-11-26T10:05:00Z').toISOString(),
    u: { _id: 'u-bob', username: 'bob', name: 'Bob' },
  } as never;
  assert.equal(
    extractRoomParticipantInstruction('下午三点大家记得对一下发版清单', 'mention_only', 'Pi 管家'),
    null,
  );
  const casualTriggered = await handleRoomAiParticipantMessage('grp-regular', casualMsg);
  assert.equal(casualTriggered, false);
  assert.equal(sent.length, 0);

  // @ai / @管家 触发，并携带原讨论组上下文
  const mentionMsg = {
    _id: 'g-2',
    rid: 'grp-regular',
    msg: '@管家 结合刚才讨论把灰度步骤发给大家',
    ts: new Date('2026-11-26T10:06:00Z').toISOString(),
    u: { _id: 'u-bob', username: 'bob', name: 'Bob' },
  } as never;
  const mentionTriggered = await handleRoomAiParticipantMessage('grp-regular', mentionMsg);
  assert.equal(mentionTriggered, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].rid, 'grp-regular');
  assert.match(capturedPrompts[0] ?? '', /Origin AI Discussion Context: AI 架构讨论组/);
  assert.match(capturedPrompts[0] ?? '', /方案 A：先在灰度验证热加载/);
  assert.match(sent[0].text, /群内响应：结合刚才讨论把灰度步骤发给大家/);

  // 自检 prompt 构造与回环过滤
  assert.equal(
    extractRoomParticipantInstruction(formatHostedRoomAiReply('Pi 管家', '收到'), 'every_message', 'Pi 管家'),
    null,
  );
  const builtPrompt = buildRoomAiParticipantPrompt({
    participant: enrolled,
    message: mentionMsg,
    instruction: '总结结论',
    messages: [casualMsg, mentionMsg],
    originMessages: useChat.getState().messages['disc-ai-1'],
    roomName: '发版协同群',
  });
  assert.match(builtPrompt, /发版协同群/);
  assert.match(builtPrompt, /Origin AI Discussion Context/);
});

test('parseHostedAgentAnswer：支持通用 AI 讨论组/参与者回复渲染且不误判托管租约卡', () => {
  const butlerAns = parseHostedAgentAnswer('🤖 Pi 管家（讨论组直连）\n已整理今日 3 条决策');
  assert.deepEqual(butlerAns, {
    provider: 'Pi 管家',
    note: '讨论组直连',
    body: '已整理今日 3 条决策',
  });

  const acpAns = parseHostedAgentAnswer('🤖 Claude Code\n已完成单元测试');
  assert.deepEqual(acpAns, {
    provider: 'Claude Code',
    note: undefined,
    body: '已完成单元测试',
  });

  const legacyAns = parseHostedAgentAnswer('🤖 Codex（worktree）\n补丁已就绪');
  assert.deepEqual(legacyAns, {
    provider: 'Codex',
    note: 'worktree',
    body: '补丁已就绪',
  });

  // 托管状态卡以 🤖 ** 开头，不得被当作普通回答吞掉头部
  assert.equal(parseHostedAgentAnswer('🤖 **AI 托管已开启** · 状态 ready\n详情如下'), null);
});
