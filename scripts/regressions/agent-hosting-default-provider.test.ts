import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultHostingBackend } from '../../apps/web/src/lib/agentHosting';
import { useUI } from '../../apps/web/src/stores/ui';

test('AI 托管始终继承本次启动的全局运行时', () => {
  const previous = useUI.getState().aiRuntimeProvider;
  try {
    useUI.setState({ aiRuntimeProvider: 'deepseek' });
    assert.equal(defaultHostingBackend(), 'deepseek');

    useUI.setState({ aiRuntimeProvider: 'codex' });
    assert.equal(defaultHostingBackend(), 'codex');

    useUI.setState({ aiRuntimeProvider: 'none' });
    assert.throws(() => defaultHostingBackend(), /当前未启用 AI/);
  } finally {
    useUI.setState({ aiRuntimeProvider: previous });
  }
});
