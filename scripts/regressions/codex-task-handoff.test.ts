import assert from 'node:assert/strict';
import test from 'node:test';
import { handoffToCodexTask } from '../../apps/web/src/lib/codexTaskHandoff';
import { useCodexWorkspace } from '../../apps/web/src/stores/codexWorkspace';
import { useUI } from '../../apps/web/src/stores/ui';

test('Codex-only handoff 不会在 DSH 进程中偷偷启动 Codex', async () => {
  const previous = useUI.getState().aiRuntimeProvider;
  try {
    useUI.setState({ aiRuntimeProvider: 'deepseek', module: 'messages' });
    await assert.rejects(
      () => handoffToCodexTask('检查一下当前房间上下文', '房间任务'),
      /当前 AI 运行时不是 Codex/,
    );
    assert.equal(useUI.getState().module, 'messages');
  } finally {
    useUI.setState({ aiRuntimeProvider: previous });
  }
});

test('Codex 运行时下的 handoff 继续复用统一管家任务面', async () => {
  const previousUi = useUI.getState();
  const previousWorkspace = useCodexWorkspace.getState();
  try {
    useUI.setState({ aiRuntimeProvider: 'codex', module: 'messages', butlerView: 'conversation' });
    useCodexWorkspace.setState({ workspaceRoot: '', composerDraft: '' });

    const result = await handoffToCodexTask('检查一下当前房间上下文', '房间任务');

    assert.equal(result, 'drafted');
    assert.equal(useUI.getState().module, 'butler-view');
    assert.equal(useCodexWorkspace.getState().composerDraft, '检查一下当前房间上下文');
  } finally {
    useUI.setState({
      aiRuntimeProvider: previousUi.aiRuntimeProvider,
      module: previousUi.module,
      butlerView: previousUi.butlerView,
    });
    useCodexWorkspace.setState({
      workspaceRoot: previousWorkspace.workspaceRoot,
      composerDraft: previousWorkspace.composerDraft,
    });
  }
});
