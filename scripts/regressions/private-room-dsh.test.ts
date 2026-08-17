import assert from 'node:assert/strict';
import test from 'node:test';
import type { HostedDshControllerOptions } from '../../apps/web/src/agent/dsh/HostedDshController';
import type { DshTranscript } from '../../apps/web/src/agent/dsh/project';
import {
  PRIVATE_ROOM_DSH_STORAGE_KEY,
  privateRoomDshKey,
  resetPrivateRoomDshForTests,
  setPrivateRoomDshControllerFactoryForTests,
  setPrivateRoomDshStorageForTests,
  usePrivateRoomDsh,
} from '../../apps/web/src/stores/privateRoomDsh';

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test('私人 DSH 会话按账号和房间隔离、恢复，并直接复用原生 session', async () => {
  const storage = new MemoryStorage();
  const transcripts = new Map<string, DshTranscript>();
  const created: string[] = [];
  const resumed: string[] = [];
  const prompted: Array<[string, string]> = [];
  const stopped: string[] = [];
  let sequence = 0;

  const restoreStorage = setPrivateRoomDshStorageForTests(storage);
  const restoreFactory = setPrivateRoomDshControllerFactoryForTests((workspaceRoot, connectionId, options: HostedDshControllerOptions) => ({
    async connect() {},
    async createSession() {
      const sessionId = `private-${++sequence}`;
      created.push(sessionId);
      transcripts.set(sessionId, { messages: [], activities: [] });
      return sessionId;
    },
    async resumeSession(sessionId) {
      resumed.push(sessionId);
      if (!transcripts.has(sessionId)) throw new Error('unknown session');
    },
    getTranscript(sessionId) {
      return transcripts.get(sessionId) ?? { messages: [], activities: [] };
    },
    async prompt(sessionId, text) {
      prompted.push([sessionId, text]);
      transcripts.set(sessionId, {
        messages: [
          { id: `${sessionId}:user`, role: 'user', text },
          { id: `${sessionId}:assistant`, role: 'assistant', text: '私人答复' },
        ],
        activities: [],
      });
      options.onSessionUpdated?.(sessionId);
      return { turnId: 'turn-1', text: '私人答复' };
    },
    async cancel() {},
    async respondApproval() {},
    async respondQuestion() {},
    async stop() {
      stopped.push(`${workspaceRoot}:${connectionId}`);
    },
  }));

  try {
    await resetPrivateRoomDshForTests();
    const firstKey = privateRoomDshKey('https://chat.example:u1', 'room-1');
    const firstId = await usePrivateRoomDsh.getState().openRoom({
      scope: 'https://chat.example:u1',
      rid: 'room-1',
      workspaceRoot: 'C:/RocketX/codex-butler',
    });
    assert.equal(firstId, 'private-1');
    assert.deepEqual(created, ['private-1']);
    assert.equal(
      JSON.parse(storage.getItem(PRIVATE_ROOM_DSH_STORAGE_KEY) ?? '{}')[firstKey],
      'private-1',
    );

    await usePrivateRoomDsh.getState().prompt(firstKey, '只给我看');
    assert.deepEqual(prompted, [['private-1', '只给我看']]);
    assert.equal(usePrivateRoomDsh.getState().sessions[firstKey]?.transcript.messages.at(-1)?.text, '私人答复');

    await resetPrivateRoomDshForTests();
    const resumedId = await usePrivateRoomDsh.getState().openRoom({
      scope: 'https://chat.example:u1',
      rid: 'room-1',
      workspaceRoot: 'C:/RocketX/codex-butler',
    });
    assert.equal(resumedId, 'private-1');
    assert.deepEqual(resumed, ['private-1']);
    assert.deepEqual(created, ['private-1']);

    const otherUserKey = privateRoomDshKey('https://chat.example:u2', 'room-1');
    const otherUserId = await usePrivateRoomDsh.getState().openRoom({
      scope: 'https://chat.example:u2',
      rid: 'room-1',
      workspaceRoot: 'C:/RocketX/codex-butler',
    });
    assert.equal(otherUserId, 'private-2');
    assert.notEqual(otherUserKey, firstKey);
    assert.equal(usePrivateRoomDsh.getState().sessions[otherUserKey]?.dshSessionId, 'private-2');
    assert.ok(stopped.length >= 2, '切换账号或重置测试时应关闭上一条私人 DSH 控制连接');
  } finally {
    await resetPrivateRoomDshForTests();
    restoreFactory();
    restoreStorage();
  }
});

test('私人 DSH 中断仅影响当前 controller 会话，并清空待处理审批与提问', async () => {
  const storage = new MemoryStorage();
  const transcripts = new Map<string, DshTranscript>();
  const controllers = new Map<string, HostedDshControllerOptions>();
  const respondedApprovals: Array<[string, boolean]> = [];
  const respondedQuestions: Array<[string, number]> = [];
  let sequence = 0;

  const restoreStorage = setPrivateRoomDshStorageForTests(storage);
  const restoreFactory = setPrivateRoomDshControllerFactoryForTests((workspaceRoot, connectionId, options) => {
    controllers.set(`${workspaceRoot}:${connectionId}`, options);
    return {
      async connect() {},
      async createSession() {
        const sessionId = `private-${++sequence}`;
        transcripts.set(sessionId, { messages: [], activities: [] });
        return sessionId;
      },
      async resumeSession(sessionId) {
        if (!transcripts.has(sessionId)) throw new Error('unknown session');
      },
      getTranscript(sessionId) {
        return transcripts.get(sessionId) ?? { messages: [], activities: [] };
      },
      async prompt() {
        return { turnId: 'turn-1', text: 'ok' };
      },
      async cancel() {},
      async respondApproval(approval, approved) {
        respondedApprovals.push([approval.approvalId, approved]);
      },
      async respondQuestion(question, answers) {
        respondedQuestions.push([question.rpcId, answers.length]);
      },
      async stop() {},
    };
  });

  try {
    await resetPrivateRoomDshForTests();
    const controllerForWorkspace = (scope: string): HostedDshControllerOptions | undefined => {
      const controllerId = `private-room-${scope.replace(/[^a-zA-Z0-9_-]/g, '').slice(-36) || 'local'}`;
      return controllers.get(`C:/RocketX/codex-butler:${controllerId}`);
    };

    const firstKey = privateRoomDshKey('https://chat.example:u1', 'room-1');
    const secondKey = privateRoomDshKey('https://chat.example:u1', 'room-2');
    const firstSessionId = await usePrivateRoomDsh.getState().openRoom({
      scope: 'https://chat.example:u1',
      rid: 'room-1',
      workspaceRoot: 'C:/RocketX/codex-butler',
    });
    const secondSessionId = await usePrivateRoomDsh.getState().openRoom({
      scope: 'https://chat.example:u1',
      rid: 'room-2',
      workspaceRoot: 'C:/RocketX/codex-butler',
    });

    const firstController = controllerForWorkspace('https://chat.example:u1');
    assert.ok(firstController, '应记录第一条 controller 的回调');

    firstController.onApproval?.({
      rpcId: 'rpc-1',
      sessionId: firstSessionId,
      approvalId: 'approval-1',
      toolName: 'write_file',
    });
    firstController.onQuestion?.({
      rpcId: 'question-1',
      sessionId: secondSessionId,
      questions: [{ id: 'q-1', question: '继续吗？' }],
    });

    assert.equal(usePrivateRoomDsh.getState().sessions[firstKey]?.status, 'waiting-input');
    assert.equal(usePrivateRoomDsh.getState().sessions[secondKey]?.status, 'waiting-input');
    assert.equal(usePrivateRoomDsh.getState().sessions[firstKey]?.approvals.length, 1);
    assert.equal(usePrivateRoomDsh.getState().sessions[secondKey]?.questions.length, 1);

    const otherKey = privateRoomDshKey('https://chat.example:u2', 'room-9');
    await usePrivateRoomDsh.getState().openRoom({
      scope: 'https://chat.example:u2',
      rid: 'room-9',
      workspaceRoot: 'C:/RocketX/codex-butler',
    });

    firstController.onInterrupted?.(new Error('旧 controller 已断开'));
    assert.equal(usePrivateRoomDsh.getState().sessions[firstKey]?.status, 'error');
    assert.equal(usePrivateRoomDsh.getState().sessions[secondKey]?.status, 'error');
    assert.equal(usePrivateRoomDsh.getState().sessions[firstKey]?.approvals.length, 0);
    assert.equal(usePrivateRoomDsh.getState().sessions[secondKey]?.questions.length, 0);
    assert.equal(usePrivateRoomDsh.getState().sessions[otherKey]?.status, 'ready');
    await usePrivateRoomDsh.getState().respondApproval(firstKey, 'approval-1', true);
    await usePrivateRoomDsh.getState().respondQuestion(secondKey, 'question-1', [{ id: 'q-1', selected: [], custom: '继续' }]);
    assert.deepEqual(respondedApprovals, []);
    assert.deepEqual(respondedQuestions, []);

    const secondController = controllerForWorkspace('https://chat.example:u2');
    assert.ok(secondController, '应记录第二条 controller 的回调');

    secondController.onApproval?.({
      rpcId: 'rpc-2',
      sessionId: usePrivateRoomDsh.getState().sessions[otherKey]?.dshSessionId ?? '',
      approvalId: 'approval-2',
      toolName: 'run_command',
    });
    assert.equal(usePrivateRoomDsh.getState().sessions[otherKey]?.status, 'waiting-input');
    assert.equal(usePrivateRoomDsh.getState().sessions[otherKey]?.approvals.length, 1);

    secondController.onInterrupted?.(new Error('当前 controller 已断开'));
    assert.equal(usePrivateRoomDsh.getState().sessions[otherKey]?.status, 'error');
    assert.equal(usePrivateRoomDsh.getState().sessions[otherKey]?.error, '当前 controller 已断开');
    assert.equal(usePrivateRoomDsh.getState().sessions[otherKey]?.approvals.length, 0);
    assert.equal(usePrivateRoomDsh.getState().sessions[otherKey]?.questions.length, 0);
    assert.equal(usePrivateRoomDsh.getState().sessions[firstKey]?.status, 'error');
    assert.equal(usePrivateRoomDsh.getState().sessions[secondKey]?.status, 'error');
  } finally {
    await resetPrivateRoomDshForTests();
    restoreFactory();
    restoreStorage();
  }
});
