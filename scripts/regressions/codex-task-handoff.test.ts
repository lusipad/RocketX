import assert from 'node:assert/strict';
import test from 'node:test';
import { handoffToCodexTask } from '../../apps/web/src/lib/codexTaskHandoff';
import { useCodexWorkspace } from '../../apps/web/src/stores/codexWorkspace';
import { useUI } from '../../apps/web/src/stores/ui';

test('Pi-only handoff 在未启用 AI 时不会启动任务或切页', async () => {
  const previous = useUI.getState().aiRuntimeProvider;
  try {
    useUI.setState({ aiRuntimeProvider: 'none', module: 'messages' });
    await assert.rejects(
      () => handoffToCodexTask('检查一下当前房间上下文', '房间任务'),
      /当前未启用 Pi 运行时/,
    );
    assert.equal(useUI.getState().module, 'messages');
  } finally {
    useUI.setState({ aiRuntimeProvider: previous });
  }
});

test('Pi 运行时下的 handoff 继续复用统一管家任务面', async () => {
  const previousUi = useUI.getState();
  const previousWorkspace = useCodexWorkspace.getState();
  try {
    useUI.setState({ aiRuntimeProvider: 'pi', module: 'messages', butlerView: 'conversation' });
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
