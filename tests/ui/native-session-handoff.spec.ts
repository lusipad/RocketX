import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated } from './support/rocket-chat-mock';

async function mountNativeSessions(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    const [reactModule, reactDomModule, component, { useAcpAgents }] = await Promise.all([
      load('/node_modules/.vite/deps/react.js'), load('/node_modules/.vite/deps/react-dom_client.js'),
      load('/src/components/AcpWorkspaceSurface.tsx'), load('/src/stores/acpAgents.ts'),
    ]);
    const runtime = window as any;
    runtime.__nativeResumes = [];
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { transformCallback: () => 0, unregisterCallback: () => {}, invoke: async (command: string) => {
      if (command === 'acp_local_session_messages') return [{ id: 'original', role: 'user', text: '原生会话已有的要求', timestamp: Date.now() }];
      return null;
    } } });
    const sessions = ['first', 'second'].map((name) => ({ provider: 'codex', preset: 'codex-acp', nativeSessionId: 'shared-native-id', title: `原生工作 ${name}`, workspaceRoot: `D:/${name}`, sourceScope: `codex:${name}`, executionProfileId: `profile-${name}`, runtimeStatus: 'unknown', createdAt: Date.now(), updatedAt: Date.now(), sourcePath: null, preview: null, stepCount: null }));
    useAcpAgents.setState({
      agents: [{ id: 'profile-first', name: 'Codex', preset: 'codex-acp', args: [], enabled: true }],
      sessions: {}, activeSessionKey: null, localSessions: sessions,
      hydrate: async () => {}, discoverLocalSessions: async () => sessions,
      resumeLocalSession: async (input: unknown) => { runtime.__nativeResumes.push(input); return {}; },
    });
    document.querySelector<HTMLElement>('#root')!.style.display = 'none';
    const host = document.createElement('div');
    host.id = 'native-handoff-under-test'; host.style.cssText = 'height:100vh;display:flex;flex-direction:column';
    document.body.append(host);
    const React = reactModule.default ?? reactModule;
    const { createRoot } = reactDomModule.default ?? reactDomModule;
    createRoot(host).render(React.createElement(component.default));
  });
}

test('external native history opens read-only and requires an explicit stopped-original handoff', async ({ page }) => {
  await bootAuthenticated(page);
  await mountNativeSessions(page);
  const surface = page.locator('#native-handoff-under-test');
  await surface.getByRole('button', { name: '管理执行器', exact: true }).click();
  await surface.getByRole('button', { name: /原生工作 first/ }).click();
  const preview = surface.getByTestId('native-session-preview');
  await expect(preview.getByText('你：原生会话已有的要求')).toBeVisible();
  await expect(preview.getByText(/系统尚未确认原端是否停止/)).toBeVisible();
  const resume = preview.getByRole('button', { name: '原端已停止，接续原会话' });
  await expect(resume).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__nativeResumes.length)).toBe(0);
  await preview.getByRole('checkbox').check();
  await resume.click();
  const [request] = await page.evaluate(() => (window as any).__nativeResumes);
  expect(request).toMatchObject({ nativeSessionId: 'shared-native-id', workspaceRoot: 'D:/first', sourceScope: 'codex:first', executionProfileId: 'profile-first', handoffConfirmed: true });
});

test('switching source revokes the previous confirmation even when native IDs match', async ({ page }) => {
  await bootAuthenticated(page);
  await mountNativeSessions(page);
  const surface = page.locator('#native-handoff-under-test');
  await surface.getByRole('button', { name: '管理执行器', exact: true }).click();
  await surface.getByRole('button', { name: /原生工作 first/ }).click();
  await surface.getByTestId('native-session-preview').getByRole('checkbox').check();
  await surface.getByRole('button', { name: /原生工作 second/ }).click();
  const preview = surface.getByTestId('native-session-preview');
  await expect(preview.getByText('来源：codex:second')).toBeVisible();
  await expect(preview.getByRole('checkbox')).not.toBeChecked();
  await expect(preview.getByRole('button', { name: '原端已停止，接续原会话' })).toBeDisabled();
});
