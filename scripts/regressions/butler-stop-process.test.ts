import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Codex 任务过程、审批与停止入口都由 codexWorkspace 原生事件流驱动', () => {
  const conversation = readFileSync('apps/web/src/components/ButlerConversation.tsx', 'utf8');
  const workspace = readFileSync('apps/web/src/stores/codexWorkspace.ts', 'utf8');
  const controller = readFileSync('apps/web/src/agent/AppServerController.ts', 'utf8');

  assert.match(conversation, /const latestActivity = events\.at\(-1\)/);
  assert.match(conversation, /const completedMessage = !running && events\.length > 0 && messages\.at\(-1\)\?\.role === 'assistant'/);
  assert.match(conversation, /const visibleMessages = completedMessage \? messages\.slice\(0, -1\) : messages/);
  assert.match(conversation, /<details className="codex-native-activities" aria-label="任务过程">/);
  assert.doesNotMatch(conversation, /<details open=\{running\} className="codex-native-activities"/);
  assert.match(conversation, /<summary>[\s\S]*?\{activityStatus\}[\s\S]*?\{latestActivity\?\.title\}[\s\S]*?\{events\.length\} 项活动[\s\S]*?<\/summary>/);
  assert.match(conversation, /events\.map\(\(event\) => <Activity key=\{event\.id\} event=\{event\} \/>\)/);
  assert.match(
    conversation,
    /\{visibleMessages\.map\(\(entry\) => <ConversationMessage key=\{entry\.id\} entry=\{entry\} renderLink=\{renderArtifactLink\} \/>\)\}[\s\S]*?<details className="codex-native-activities"[\s\S]*?\{completedMessage \? <ConversationMessage entry=\{completedMessage\} renderLink=\{renderArtifactLink\} \/> : null\}/,
  );
  assert.match(conversation, /request\.kind === 'approval'/);
  assert.match(conversation, /<ApprovalCard key=\{request\.id\} request=\{request\} \/>/);
  assert.match(conversation, /<InputCard key=\{request\.id\} request=\{request\} \/>/);
  assert.match(conversation, /aria-label="停止任务"/);
  assert.match(conversation, /onClick=\{\(\) => void interrupt\(\)\}/);
  assert.doesNotMatch(conversation, /ButlerProcess|useButler\(|stopButlerCodexTurn/);

  assert.match(workspace, /if \(method === 'turn\/started'\)/);
  assert.match(workspace, /if \(method === 'item\/agentMessage\/delta'\)/);
  assert.match(workspace, /if \(method === 'item\/started' \|\| method === 'item\/completed'\)/);
  assert.match(workspace, /if \(method === 'item\/commandExecution\/outputDelta'\)/);
  assert.match(workspace, /if \(method === 'turn\/diff\/updated'\)/);
  assert.match(workspace, /if \(method !== 'turn\/completed'\) return;/);
  assert.match(workspace, /const kind = request\.method === 'item\/tool\/requestUserInput'/);
  assert.match(workspace, /status: 'waiting-input'/);
  assert.match(workspace, /interrupt: async \(\) => \{/);
  assert.match(workspace, /rejectPendingRequests\('用户已停止当前任务', state\.activeThreadId\)/);
  assert.match(workspace, /setThreadState\(state\.activeThreadId,[\s\S]*?status: 'ready',[\s\S]*?activeTurnId: undefined,[\s\S]*?streamingText: '',[\s\S]*?queuedMessages: \[],/);

  assert.match(controller, /async interruptTurn\(threadId: string, turnId: string\): Promise<void> \{/);
  assert.match(controller, /request\('turn\/interrupt', \{ threadId, turnId \}\)/);
});
