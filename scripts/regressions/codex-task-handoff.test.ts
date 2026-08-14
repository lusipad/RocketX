import assert from 'node:assert/strict';
import test from 'node:test';
import { handoffToCodexTask } from '../../apps/web/src/lib/codexTaskHandoff';
import { useCodexWorkspace } from '../../apps/web/src/stores/codexWorkspace';
import { useUI } from '../../apps/web/src/stores/ui';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test('Codex-only handoff 临时切到 codex，但手动重进管家仍恢复 deepseek 偏好', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  const previousUi = useUI.getState();
  const previousWorkspace = useCodexWorkspace.getState();

  try {
    storage.setItem('rocketx.butler.task-provider', 'deepseek');
    useUI.setState({
      module: 'messages',
      butlerView: 'conversation',
      butlerTaskProvider: 'deepseek',
      butlerTaskProviderPreference: 'deepseek',
    });
    useCodexWorkspace.setState({ workspaceRoot: '', composerDraft: '' });

    const result = await handoffToCodexTask('检查一下当前房间上下文', '房间任务');

    assert.equal(result, 'drafted');
    assert.equal(storage.getItem('rocketx.butler.task-provider'), 'deepseek');
    assert.equal(useUI.getState().module, 'butler-view');
    assert.equal(useUI.getState().butlerView, 'conversation');
    assert.equal(useUI.getState().butlerTaskProvider, 'codex');
    assert.equal(useCodexWorkspace.getState().composerDraft, '检查一下当前房间上下文');

    useUI.getState().setModule('messages');
    useUI.getState().setModule('butler-view');
    assert.equal(useUI.getState().butlerTaskProvider, 'deepseek');
  } finally {
    useUI.setState({
      module: previousUi.module,
      butlerView: previousUi.butlerView,
      butlerTaskProvider: previousUi.butlerTaskProvider,
      butlerTaskProviderPreference: previousUi.butlerTaskProviderPreference,
    });
    useCodexWorkspace.setState({
      workspaceRoot: previousWorkspace.workspaceRoot,
      composerDraft: previousWorkspace.composerDraft,
    });
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
