import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDshBridgeLine } from '../../apps/web/src/agent/dsh/DshController';
import { approvalResponse, questionResponse } from '../../apps/web/src/agent/dsh/protocol';
import { projectDshTranscript } from '../../apps/web/src/agent/dsh/project';
import {
  permissionSettings,
  permissionSelection,
} from '../../apps/web/src/agent/dsh/config';
import {
  applyDshMuxFrame,
  dshCredentialState,
  useDshWorkspace,
} from '../../apps/web/src/stores/dshWorkspace';

test('DSH bridge frame parser keeps answerable request rpcId intact', () => {
  const frame = parseDshBridgeLine(JSON.stringify({
    kind: 'mux',
    envelope: {
      type: 'server-request',
      rpcId: 'rpc-approval-7',
      method: 'approval/requested',
      payload: {
        type: 'approval/requested',
        sessionId: 'session-1',
        approvalId: 'approval-1',
        toolName: 'shell',
      },
    },
  }));

  assert.equal(frame.kind, 'mux');
  if (frame.kind !== 'mux') throw new Error('unreachable');
  assert.equal(frame.envelope.rpcId, 'rpc-approval-7');
  assert.throws(
    () => parseDshBridgeLine('{"kind":"mux","envelope":{"type":"server-request"}}'),
    /无效 mux 事件/,
  );
});

test('DSH workspace keeps concurrent approvals and questions until each rpcId resolves', () => {
  const sessionId = 'session-pending';
  useDshWorkspace.setState({
    activeSessionId: sessionId,
    sessions: [{ id: sessionId, updatedAt: 1, status: 'running', blank: false }],
    pendingApproval: null,
    pendingQuestion: null,
  });

  for (const [rpcId, approvalId] of [['rpc-a1', 'approval-1'], ['rpc-a2', 'approval-2']]) {
    applyDshMuxFrame({
      type: 'server-request', rpcId, method: 'approval/requested',
      payload: { type: 'approval/requested', sessionId, approvalId, toolName: 'shell' },
    });
  }
  assert.equal(useDshWorkspace.getState().pendingApproval?.rpcId, 'rpc-a1');
  applyDshMuxFrame({
    type: 'server-request', rpcId: 'push-a1', method: 'approval/resolved',
    payload: { type: 'approval/resolved', sessionId, approvalId: 'approval-1', outcome: 'allowed-once' },
  });
  assert.equal(useDshWorkspace.getState().pendingApproval?.rpcId, 'rpc-a2');

  for (const rpcId of ['rpc-q1', 'rpc-q2']) {
    applyDshMuxFrame({
      type: 'server-request', rpcId, method: 'question/requested',
      payload: { type: 'question/requested', sessionId, questions: [{ id: rpcId, question: '继续？' }] },
    });
  }
  assert.equal(useDshWorkspace.getState().pendingQuestion?.rpcId, 'rpc-q1');
  applyDshMuxFrame({
    type: 'server-request', rpcId: 'push-q1', method: 'question/resolved',
    payload: { type: 'question/resolved', sessionId, questionRpcId: 'rpc-q1', outcome: 'answered' },
  });
  assert.equal(useDshWorkspace.getState().pendingQuestion?.rpcId, 'rpc-q2');
});

test('DSH workspace ignores stale title projections and mirrors the authoritative queue', () => {
  const sessionId = 'session-projection';
  useDshWorkspace.setState({
    activeSessionId: sessionId,
    sessions: [{ id: sessionId, title: '旧标题', updatedAt: 1, status: 'running', blank: false }],
    queuedMessages: [],
  });
  applyDshMuxFrame({
    type: 'server-request', rpcId: 'projection-2', method: 'session/projection',
    payload: { type: 'session/projection', sessionId, key: 'title', value: '新标题', seq: 2 },
  });
  applyDshMuxFrame({
    type: 'server-request', rpcId: 'projection-1', method: 'session/projection',
    payload: { type: 'session/projection', sessionId, key: 'title', value: '过期标题', seq: 1 },
  });
  assert.equal(useDshWorkspace.getState().sessions[0]?.title, '新标题');

  applyDshMuxFrame({
    type: 'server-request', rpcId: 'queue-1', method: 'session/queue',
    payload: {
      type: 'session/queue', sessionId,
      items: [{
        id: 'message-1', placement: 'queued',
        message: { id: 'message-1', content: [{ type: 'text', text: '稍后执行' }] },
      }],
    },
  });
  assert.deepEqual(useDshWorkspace.getState().queuedMessages, [
    { id: 'message-1', placement: 'queued', text: '稍后执行' },
  ]);
});

test('DSH credentials keep environment-provided keys configured but read-only', () => {
  assert.deepEqual(dshCredentialState({ configured: true, writable: false }), {
    credentialConfigured: true,
    credentialWritable: false,
  });
});

test('DSH configuration reads permission presets from the native settings schema and projection', () => {
  const settings = permissionSettings({
    writable: true,
    namespaces: [{
      ns: 'permission',
      revision: 4,
      value: { defaultPreset: 'workspace-write' },
      schema: {
        uid: 4,
        refs: {
          1: { type: 'const', value: 'workspace-write', meta: { description: '工作区写入' } },
          2: { type: 'const', value: 'danger-full-access' },
          3: { type: 'union', list: [1, 2] },
          4: { type: 'object', dict: { defaultPreset: 3 } },
        },
      },
    }],
  });
  assert.deepEqual(settings, {
    writable: true,
    revision: 4,
    currentValue: 'workspace-write',
    options: [
      { id: 'workspace-write', name: '工作区写入' },
      { id: 'danger-full-access', name: 'Danger Full Access' },
    ],
  });

  assert.deepEqual(permissionSelection({
    currentValue: 'danger-full-access',
    options: [
      { value: 'workspace-write', name: '工作区写入', description: '限工作区，越权时询问' },
      { value: 'danger-full-access', name: '完全访问', description: '不询问' },
      { value: 'custom', name: '自定义' },
    ],
  }), {
    currentValue: 'danger-full-access',
    options: [
      { id: 'workspace-write', name: '工作区写入', description: '限工作区，越权时询问' },
      { id: 'danger-full-access', name: '完全访问', description: '不询问' },
    ],
  });
});

test('DSH workspace projects the current session permission selection', () => {
  const sessionId = 'session-permission';
  useDshWorkspace.setState({
    activeSessionId: sessionId,
    sessions: [{ id: sessionId, updatedAt: 1, status: 'idle', blank: true }],
    activePermission: null,
  });
  applyDshMuxFrame({
    type: 'server-request', rpcId: 'permission-projection', method: 'session/projection',
    payload: {
      type: 'session/projection', sessionId, key: 'permissions', seq: 3,
      value: {
        currentValue: 'workspace-write',
        options: [{ value: 'workspace-write', name: 'Workspace Write' }],
      },
    },
  });
  assert.equal(useDshWorkspace.getState().activePermission?.currentValue, 'workspace-write');
});

test('DSH transcript shows only human prompts, streams draft text, and completes tools', () => {
  const transcript = projectDshTranscript('session-1', [
    {
      type: 'user/message', seq: 1, time: 1,
      data: {
        id: 'instructions', role: 'user', content: [{ type: 'text', text: 'hidden instructions' }],
        source: { kind: 'plugin', plugin: 'agent-instructions' },
      },
    },
    {
      type: 'user/message', seq: 2, time: 2,
      data: {
        id: 'human', role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' },
      },
    },
    {
      type: 'assistant/chunk', seq: 3, time: 3,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '正在' } },
    },
    {
      type: 'assistant/chunk', seq: 4, time: 4,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '处理' } },
    },
    {
      type: 'tool/call', seq: 5, time: 5,
      data: { turn: 1, step: 1, callId: 'call-1', name: 'read_file', arguments: '{"path":"README.md"}' },
    },
    {
      type: 'tool/result', seq: 6, time: 6,
      data: {
        turn: 1,
        step: 1,
        message: { id: 'result-1', role: 'user', content: [], source: { kind: 'tool', callId: 'call-1' } },
      },
    },
  ]);

  assert.deepEqual(transcript.messages.map(({ role, text }) => ({ role, text })), [
    { role: 'user', text: '你好' },
    { role: 'assistant', text: '正在处理' },
  ]);
  assert.equal(transcript.activities[0]?.title, 'read_file');
  assert.equal(transcript.activities[0]?.status, 'completed');
});

test('final assistant message replaces its raw chunks and turn errors stay out of message text', () => {
  const transcript = projectDshTranscript('session-1', [
    {
      type: 'assistant/chunk', seq: 1, time: 1,
      data: { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: 'draft' } },
    },
    {
      type: 'assistant/chunk', seq: 2, time: 2,
      data: { turn: 2, step: 1, chunk: { type: 'finish', reason: { kind: 'error' } } },
    },
    {
      type: 'assistant/message', seq: 3, time: 3,
      data: {
        turn: 2,
        step: 1,
        message: { id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text: '完成' }], source: { kind: 'model' } },
      },
    },
    {
      type: 'turn/end', seq: 4, time: 4,
      data: { turn: 2, reason: { kind: 'error', error: { code: 'BROKEN', message: '模型失败' } } },
    },
  ]);

  assert.deepEqual(transcript.messages.map((message) => message.text), ['完成']);
  assert.equal(transcript.activities[0]?.status, 'failed');
  assert.equal(transcript.activities[0]?.summary, '模型失败');
});

test('DSH approval and question responses use the original server rpcId', () => {
  assert.deepEqual(approvalResponse({
    rpcId: 'rpc-a', sessionId: 'session-1', approvalId: 'approval-1', toolName: 'shell',
  }, true), {
    type: 'client-response',
    rpcId: 'rpc-a',
    result: {
      ok: true,
      value: { sessionId: 'session-1', approvalId: 'approval-1', outcome: 'allowed-once' },
    },
  });

  assert.deepEqual(questionResponse({
    rpcId: 'rpc-q',
    sessionId: 'session-1',
    questions: [{ id: 'choice', question: '选哪个？' }],
  }, [{ id: 'choice', selected: ['A'], custom: '补充' }]), {
    type: 'client-response',
    rpcId: 'rpc-q',
    result: {
      ok: true,
      value: {
        sessionId: 'session-1',
        answer: { answers: [{ id: 'choice', selected: ['A'], custom: '补充' }] },
      },
    },
  });
});
