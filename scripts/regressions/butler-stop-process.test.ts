import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { enUS } from '../../apps/web/src/i18n/locales/en-US';
import { zhCN } from '../../apps/web/src/i18n/locales/zh-CN';

test('Codex 任务过程、审批与停止入口都由 codexWorkspace 原生事件流驱动', () => {
  const conversation = readFileSync('apps/web/src/components/ButlerConversation.tsx', 'utf8');
  const workspace = readFileSync('apps/web/src/stores/codexWorkspace.ts', 'utf8');
  const controller = readFileSync('apps/web/src/agent/AppServerController.ts', 'utf8');

  assert.match(conversation, /const latestActivity = events\.at\(-1\)/);
  assert.match(conversation, /const completedMessage = !running && messages\.at\(-1\)\?\.role === 'assistant'/);
  assert.match(conversation, /const visibleMessages = completedMessage \? messages\.slice\(0, -1\) : messages/);
  assert.match(conversation, /const activeAssistantMessage:[\s\S]*?streamingText[\s\S]*?id: 'active-assistant'[\s\S]*?: completedMessage/);
  assert.match(conversation, /<details className="codex-native-activities" aria-label=\{t\('butler\.conversation\.activityAria'\)\}>/);
  assert.match(zhCN['butler.conversation.activityAria'], /^任务过程$/);
  assert.ok(enUS['butler.conversation.activityAria'].trim());
  assert.doesNotMatch(conversation, /<details open=\{running\} className="codex-native-activities"/);
  assert.match(conversation, /<summary>[\s\S]*?\{activityStatus\}[\s\S]*?\{latestActivity\?\.title\}[\s\S]*?tp\(events\.length, 'butler\.conversation\.activityCountOne', 'butler\.conversation\.activityCountOther'\)[\s\S]*?<\/summary>/);
  assert.match(zhCN['butler.conversation.activityCountOne'], /\{count\} 项活动/);
  assert.match(zhCN['butler.conversation.activityCountOther'], /\{count\} 项活动/);
  assert.ok(enUS['butler.conversation.activityCountOne'].trim());
  assert.ok(enUS['butler.conversation.activityCountOther'].trim());
  assert.match(conversation, /events\.map\(\(event\) => <Activity key=\{event\.id\} event=\{event\} \/>\)/);
  assert.match(
    conversation,
    /\{visibleMessages\.map\(\(entry\) => <ConversationMessage key=\{entry\.id\} entry=\{entry\} renderLink=\{renderArtifactLink\} \/>\)\}[\s\S]*?<details className="codex-native-activities"[\s\S]*?\{activeAssistantMessage \? \([\s\S]*?key="active-assistant"[\s\S]*?entry=\{activeAssistantMessage\}[\s\S]*?progressive[\s\S]*?streaming=\{Boolean\(streamingText\)\}/,
  );
  assert.match(conversation, /request\.kind === 'approval'/);
  assert.match(conversation, /<ApprovalCard key=\{request\.id\} request=\{request\} \/>/);
  assert.match(conversation, /<InputCard key=\{request\.id\} request=\{request\} \/>/);
  assert.match(conversation, /aria-label=\{t\('butler\.conversation\.stopTaskAria'\)\}/);
  assert.match(zhCN['butler.conversation.stopTaskAria'], /^停止任务$/);
  assert.ok(enUS['butler.conversation.stopTaskAria'].trim());
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
  assert.match(workspace, /await get\(\)\.interruptThread\(threadId\)/);
  assert.match(workspace, /interruptThread: async \(threadId\) =>/);
  assert.match(workspace, /rejectPendingRequests\(t\('agent\.codexWorkspace\.reject\.userStopped'\), threadId\)/);
  assert.match(zhCN['agent.codexWorkspace.reject.userStopped'], /用户已停止当前任务/);
  assert.ok(enUS['agent.codexWorkspace.reject.userStopped'].trim());
  assert.match(workspace, /setThreadState\(threadId,[\s\S]*?status: 'ready',[\s\S]*?activeTurnId: undefined,[\s\S]*?streamingText: '',[\s\S]*?queuedMessages: \[],/);

  assert.match(controller, /async interruptTurn\(threadId: string, turnId: string\): Promise<void> \{/);
  assert.match(controller, /request\('turn\/interrupt', \{ threadId, turnId \}\)/);
});
