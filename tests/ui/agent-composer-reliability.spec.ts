import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated } from './support/rocket-chat-mock';

async function mountComposer(page: Page, kind: 'butler' | 'acp'): Promise<void> {
  await page.waitForFunction(async () => {
    const { useUI } = await import('/src/stores/ui.ts');
    return useUI.getState().startupStage === 'background-ready';
  });
  await page.evaluate(async (composerKind) => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    const [reactModule, reactDomModule, { useCodexWorkspace }, { useAcpAgents }, { useUI }, { useAuth }, component] = await Promise.all([
      load('/node_modules/.vite/deps/react.js'),
      load('/node_modules/.vite/deps/react-dom_client.js'),
      load('/src/stores/codexWorkspace.ts'),
      load('/src/stores/acpAgents.ts'),
      load('/src/stores/ui.ts'),
      load('/src/stores/auth.ts'),
      load(composerKind === 'butler' ? '/src/components/ButlerConversation.tsx' : '/src/components/AcpWorkspaceSurface.tsx'),
    ]);
    const runtime = window as any;
    runtime.__composerRequests = [];
    runtime.__finishComposerRequest = (index: number, fail: boolean) => {
      const request = runtime.__composerRequests[index];
      if (fail) request.reject(new Error('测试发送失败'));
      else request.resolve({ stopReason: 'end_turn' });
    };
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke: async () => null, transformCallback: () => 0, unregisterCallback: () => {} },
    });
    const deferredSend = (target: string, text: string, images: unknown[] = []) => new Promise((resolve, reject) => {
      runtime.__composerRequests.push({ target, text, images, resolve, reject });
    });
    useUI.setState({ aiRuntimeProvider: 'pi', butlerSidebarCollapsed: true });
    runtime.__originalComposerSend = useCodexWorkspace.getState().send;
    useCodexWorkspace.setState({
      scope: 'composer-test-account', workspaceRoot: 'D:/project', workspaceRoots: ['D:/project'],
      activeThreadId: 'a', status: 'ready', threads: [], messages: [], events: [],
      pendingRequests: [], queuedMessages: [], streamingText: '',
      send: (text: string, images: unknown[], _mode: unknown, target: any) => deferredSend(target?.threadId ?? useCodexWorkspace.getState().activeThreadId, text, images),
    });
    const session = (key: string) => ({
      sessionKey: key, agentId: 'agent', agentName: 'Test Agent', workspaceRoot: 'D:/project',
      acpSessionId: key, status: 'ready', availableCommands: [], availableModes: [],
      messages: [], plan: [], toolCalls: [], pendingPermissions: [], streamingText: '',
      streamingThought: '', stderrLogs: [], modes: null, models: null,
      title: `会话 ${key}`, linkedTodoId: null, autonomyMode: 'confirm',
      turnCount: 0, createdAt: Date.now(), updatedAt: Date.now(),
    });
    useAcpAgents.setState({
      agents: [{ id: 'agent', name: 'Test Agent', preset: 'custom', args: [], enabled: true }],
      sessions: { a: session('a'), b: session('b') }, activeSessionKey: 'a',
      hydrate: async () => {}, discoverLocalSessions: async () => [],
      sendPrompt: (target: string, text: string) => deferredSend(target, text),
    });
    runtime.__selectComposer = async (recipient: string, workspaceRoot = 'D:/project', scope = 'composer-test-account') => {
      const userId = scope === 'composer-test-account' ? 'user-me' : scope;
      if (userId !== useAuth.getState().user?._id) {
        useAuth.setState((state: any) => ({ user: { ...state.user, _id: userId } }));
        // Wait for the actual account switch before selecting this fixture's conversation.
        if (useUI.getState().startupStage !== 'background-ready') {
          await new Promise<void>((resolve) => {
            const unsubscribe = useUI.subscribe((state: any) => {
              if (state.startupStage !== 'background-ready') return;
              unsubscribe();
              resolve();
            });
          });
        }
      }
      useCodexWorkspace.setState({ activeThreadId: recipient, workspaceRoot, scope, status: 'ready' });
      useAcpAgents.setState((state: any) => ({
        activeSessionKey: recipient,
        sessions: { ...state.sessions, [recipient]: { ...state.sessions[recipient], workspaceRoot } },
      }));
    };
    document.querySelector<HTMLElement>('#root')!.style.display = 'none';
    const host = document.createElement('div');
    host.id = 'composer-under-test';
    host.style.cssText = 'height:100vh;display:flex;flex-direction:column';
    document.body.append(host);
    const React = reactModule.default ?? reactModule;
    const { createRoot } = reactDomModule.default ?? reactDomModule;
    createRoot(host).render(React.createElement(component.default));
  }, kind);
  await expect(page.locator('#composer-under-test textarea')).toBeEditable();
}

for (const kind of ['butler', 'acp'] as const) {
  test(`${kind}: drafts survive conversation switches and reload without crossing accounts`, async ({ page }) => {
    await bootAuthenticated(page);
    await mountComposer(page, kind);
    const input = page.locator('#composer-under-test textarea');
    await input.fill('A 会话未发送的要求');
    await page.evaluate(() => (window as any).__selectComposer('b'));
    await expect(input).toHaveValue('');
    await input.fill('B 会话草稿');
    await page.evaluate(() => (window as any).__selectComposer('a', 'D:/other-project'));
    await expect(input).toHaveValue('');
    await page.evaluate(() => (window as any).__selectComposer('a', 'D:/project', 'other-account'));
    await expect(input).toHaveValue('');
    await page.evaluate(() => (window as any).__selectComposer('a'));
    await expect(input).toHaveValue('A 会话未发送的要求');
    await page.reload();
    await mountComposer(page, kind);
    await expect(input).toHaveValue('A 会话未发送的要求');
    await page.evaluate(() => (window as any).__selectComposer('b'));
    await expect(input).toHaveValue('B 会话草稿');
  });

  test(`${kind}: IME does not send; failed requests keep their recipient and newer drafts`, async ({ page }) => {
    await bootAuthenticated(page);
    await mountComposer(page, kind);
    const host = page.locator('#composer-under-test');
    const input = host.locator('textarea');
    await input.fill('原始要求');
    await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
    expect(await page.evaluate(() => (window as any).__composerRequests.length)).toBe(0);
    await input.press('Enter');
    await input.press('Enter');
    await expect.poll(() => page.evaluate(() => (window as any).__composerRequests.length)).toBe(1);
    await input.fill('A 新草稿');
    await page.evaluate(() => (window as any).__selectComposer('b'));
    await input.fill('B 新草稿');
    await page.evaluate(() => (window as any).__finishComposerRequest(0, true));
    await expect(input).toHaveValue('B 新草稿');
    await expect(host.getByRole('button', { name: '重试原请求' })).toHaveCount(0);
    await page.evaluate(() => (window as any).__selectComposer('a'));
    await expect(input).toHaveValue('A 新草稿');
    await expect(host.getByRole('alert')).toContainText('原始要求');
    if (kind === 'acp') {
      await expect(host.getByRole('button', { name: '重试原请求' })).toBeDisabled();
      await host.getByLabel('已核对原会话，可以重发').check();
    }
    await host.getByRole('button', { name: '重试原请求' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__composerRequests.length)).toBe(2);
    expect(await page.evaluate(() => (window as any).__composerRequests.map((request: any) => ({ target: request.target, text: request.text })))).toEqual([
      { target: 'a', text: '原始要求' }, { target: 'a', text: '原始要求' },
    ]);
    await page.evaluate(() => (window as any).__finishComposerRequest(1, false));
    await expect(input).toHaveValue('A 新草稿');
  });
}

test('butler: read image attachments stay with the draft after reload', async ({ page }) => {
  await bootAuthenticated(page);
  await mountComposer(page, 'butler');
  const host = page.locator('#composer-under-test');
  await host.getByLabel('选择图片').setInputFiles({
    name: 'draft.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZQAAAABJRU5ErkJggg==', 'base64'),
  });
  await expect(host.getByRole('button', { name: '移除图片 draft.png' })).toBeVisible();
  await page.evaluate(() => (window as any).__selectComposer('b'));
  await expect(host.getByRole('button', { name: '移除图片 draft.png' })).toHaveCount(0);
  await page.reload();
  await mountComposer(page, 'butler');
  await expect(host.getByRole('button', { name: '移除图片 draft.png' })).toBeVisible();
});

test('draft hydration cannot overwrite a migrated request or newer typing', async ({ page }) => {
  await bootAuthenticated(page);
  const result = await page.evaluate(async () => {
    const { useAgentComposerDrafts, agentComposerKey } = await new Function('return import("/src/stores/agentComposerDrafts.ts")')();
    const store = useAgentComposerDrafts.getState();
    const target = { scope: 'late-load', kind: 'butler', workspaceRoot: 'D:/project', recipientId: null };
    const key = agentComposerKey(target);
    await store.load(key);
    store.edit(key, { text: '原始要求', images: [{ name: 'migration.png', type: 'image/png', size: 1, dataUrl: 'data:image/png;base64,YQ==' }] });
    const request = store.begin(target);
    const destination = agentComposerKey({ ...target, recipientId: 'created-thread' });
    const originalGet = IDBObjectStore.prototype.get;
    const delayed: any = { result: undefined };
    const typingKey = agentComposerKey({ ...target, recipientId: 'typing-thread' });
    const delayedTyping: any = { result: { text: '旧草稿', images: [], failed: [], loaded: true } };
    IDBObjectStore.prototype.get = function (query: any) {
      if (this.name === 'drafts' && query === destination) return delayed;
      if (this.name === 'drafts' && query === typingKey) return delayedTyping;
      return originalGet.call(this, query);
    };
    try {
      const loading = store.load(destination);
      while (!delayed.onsuccess) await new Promise((resolve) => setTimeout(resolve, 0));
      const migrated = store.bindRecipient(key, request.id, 'created-thread');
      delayed.onsuccess();
      await loading;
      store.finish(migrated, request.id, new Error('创建后发送失败'));
      const typingLoad = store.load(typingKey);
      while (!delayedTyping.onsuccess) await new Promise((resolve) => setTimeout(resolve, 0));
      store.edit(typingKey, { text: '读取期间的新输入' });
      delayedTyping.onsuccess();
      await typingLoad;
      const migratedDraft = useAgentComposerDrafts.getState().drafts[destination];
      return { text: migratedDraft.failed[0]?.text, recipient: migratedDraft.failed[0]?.target.recipientId, typing: useAgentComposerDrafts.getState().drafts[typingKey].text };
    } finally {
      IDBObjectStore.prototype.get = originalGet;
    }
  });
  expect(result).toEqual({ text: '原始要求', recipient: 'created-thread', typing: '读取期间的新输入' });
  await page.reload();
  const restoredImages = await page.evaluate(async () => {
    const { useAgentComposerDrafts, agentComposerKey } = await new Function('return import("/src/stores/agentComposerDrafts.ts")')();
    const key = agentComposerKey({ scope: 'late-load', kind: 'butler', workspaceRoot: 'D:/project', recipientId: 'created-thread' });
    await useAgentComposerDrafts.getState().load(key);
    return useAgentComposerDrafts.getState().drafts[key].failed[0]?.images.map((image: any) => image.name);
  });
  expect(restoredImages).toEqual(['migration.png']);
});

async function attachmentCount(page: Page): Promise<number> {
  return page.evaluate(() => new Promise<number>((resolve, reject) => {
    const opening = indexedDB.open('rocketx-agent-composer-drafts', 1);
    opening.onsuccess = () => {
      const db = opening.result;
      const request = db.transaction('images').objectStore('images').count();
      request.onsuccess = () => { resolve(request.result); db.close(); };
      request.onerror = () => { reject(request.error); db.close(); };
    };
    opening.onerror = () => reject(opening.error);
  }));
}

test('attachment cleanup preserves other drafts and removes images after their last reference is removed', async ({ page }) => {
  await bootAuthenticated(page);
  await mountComposer(page, 'butler');
  const host = page.locator('#composer-under-test');
  const image = { name: 'attached.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZQAAAABJRU5ErkJggg==', 'base64') };
  await host.getByLabel('选择图片').setInputFiles(image);
  await expect.poll(() => attachmentCount(page)).toBe(1);
  await page.evaluate(() => (window as any).__selectComposer('b'));
  await host.getByLabel('选择图片').setInputFiles(image);
  await expect.poll(() => attachmentCount(page)).toBe(2);
  await page.evaluate(() => (window as any).__selectComposer('a'));
  await host.getByRole('button', { name: '移除图片 attached.png' }).click();
  await expect.poll(() => attachmentCount(page)).toBe(1);
  await page.evaluate(() => (window as any).__selectComposer('b'));
  await expect(host.getByRole('button', { name: '移除图片 attached.png' })).toBeVisible();
  await host.getByRole('button', { name: '移除图片 attached.png' }).click();
  await expect.poll(() => attachmentCount(page)).toBe(0);
});

test('unfinished image reads block send and attach to their original conversation', async ({ page }) => {
  await bootAuthenticated(page);
  await mountComposer(page, 'butler');
  await page.evaluate(() => {
    const read = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function (blob: Blob) {
      (window as any).__releaseImageRead = () => read.call(this, blob);
    };
  });
  const host = page.locator('#composer-under-test');
  await host.locator('textarea').fill('带图片的要求');
  await host.getByLabel('选择图片').setInputFiles({
    name: 'pending.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZQAAAABJRU5ErkJggg==', 'base64'),
  });
  await expect(host.getByText('正在读取图片，读取完成后可发送。')).toBeVisible();
  await host.locator('textarea').press('Enter');
  expect(await page.evaluate(() => (window as any).__composerRequests.length)).toBe(0);
  await page.evaluate(() => (window as any).__selectComposer('b'));
  await page.evaluate(() => (window as any).__releaseImageRead());
  await expect(host.getByRole('button', { name: '移除图片 pending.png' })).toHaveCount(0);
  await page.evaluate(() => (window as any).__selectComposer('a'));
  await expect(host.getByRole('button', { name: '移除图片 pending.png' })).toBeVisible();
  await expect(host.locator('textarea')).toHaveValue('带图片的要求');
});

test('unconfirmed sends survive reload and do not replay automatically', async ({ page }) => {
  await bootAuthenticated(page);
  await mountComposer(page, 'butler');
  const host = page.locator('#composer-under-test');
  await host.locator('textarea').fill('需要核对是否已执行');
  await host.locator('textarea').press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__composerRequests.length)).toBe(1);
  await host.locator('textarea').fill('下一条未发送要求');
  await page.reload();
  await mountComposer(page, 'butler');
  await expect(host.locator('textarea')).toHaveValue('下一条未发送要求');
  await expect(host.getByRole('alert')).toContainText('上次发送结果未确认');
  await expect(host.getByRole('button', { name: '重试原请求' })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__composerRequests.length)).toBe(0);
});

async function installRealSendRuntime(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { useCodexWorkspace, setCodexWorkspaceControllerFactory, resetCodexWorkspaceForTests } = await new Function('return import("/src/stores/codexWorkspace.ts")')();
    const runtime = window as any;
    await resetCodexWorkspaceForTests();
    runtime.__actualDispatches = [];
    runtime.__delayAttachment = false;
    runtime.__failThreadRefresh = false;
    setCodexWorkspaceControllerFactory(() => ({
      currentSessionId: 'runtime-session', currentWorkspaceRoot: 'D:/project',
      connect: async () => ({
        models: [{ id: 'test', model: 'test', isDefault: true, supportedReasoningEfforts: [], defaultReasoningEffort: null }],
        permissionProfiles: [], skills: [], apps: [], plugins: null, catalogErrors: {},
      }),
      listThreads: async () => {
        if (runtime.__delayThreadRefresh) await new Promise((resolve) => { runtime.__releaseThreadRefresh = resolve; });
        if (runtime.__failThreadRefresh) throw new Error('会话列表刷新失败');
        return [{ id: 'created-thread', cwd: 'D:/project', name: '新任务', preview: '' }];
      },
      startThread: async () => ({ id: 'created-thread', cwd: 'D:/project', name: '新任务', preview: '' }),
      startTurn: async (threadId: string, input: unknown[], _selection: unknown, options: any) => {
        runtime.__actualDispatches.push({ threadId, input, workspaceRoot: options?.workspaceRoot });
        return 'turn';
      },
      switchWorkspaceRoot: () => true,
      stop: async () => {},
    }));
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        invoke: async (command: string) => {
          if (command === 'pi_agent_attachment_write') {
            if (runtime.__delayAttachment) await new Promise((resolve) => { runtime.__releaseAttachment = resolve; });
            return { path: 'D:/runtime/image.png', root: 'D:/runtime' };
          }
          return null;
        },
        transformCallback: () => 0, unregisterCallback: () => {},
      },
    });
    const thread = () => ({
      workspaceRoot: 'D:/project', status: 'ready', error: null, turns: [],
      messages: [], events: [], streamingText: '', pendingRequests: [], queuedMessages: [],
    });
    useCodexWorkspace.setState({
      send: runtime.__originalComposerSend,
      scope: 'composer-test-account', workspaceRoot: 'D:/project', workspaceRoots: ['D:/project'],
      activeThreadId: 'a', status: 'ready', threadStates: { a: thread(), b: thread() },
    });
    await useCodexWorkspace.getState().connect({ refreshThreads: false });
  });
}

test('real send preserves its thread while attachment preparation is asynchronous', async ({ page }) => {
  await bootAuthenticated(page);
  await mountComposer(page, 'butler');
  await installRealSendRuntime(page);
  const outcome = await page.evaluate(async () => {
    const { useCodexWorkspace } = await new Function('return import("/src/stores/codexWorkspace.ts")')();
    const runtime = window as any;
    runtime.__delayAttachment = true;
    const sending = useCodexWorkspace.getState().send('发送给 A', [{ name: 'x.png', type: 'image/png', size: 1, dataUrl: 'data:image/png;base64,YQ==' }]);
    while (!runtime.__releaseAttachment) await new Promise((resolve) => setTimeout(resolve, 0));
    useCodexWorkspace.setState({ activeThreadId: 'b', workspaceRoot: 'D:/other-project' });
    runtime.__releaseAttachment();
    await sending;
    return { targets: runtime.__actualDispatches.map((entry: any) => ({ threadId: entry.threadId, cwd: entry.workspaceRoot })), active: useCodexWorkspace.getState().activeThreadId };
  });
  expect(outcome).toEqual({ targets: [{ threadId: 'a', cwd: 'D:/project' }], active: 'b' });
});

test('real send refuses to use another account runtime after attachments finish', async ({ page }) => {
  await bootAuthenticated(page);
  await mountComposer(page, 'butler');
  await installRealSendRuntime(page);
  const outcome = await page.evaluate(async () => {
    const { useCodexWorkspace } = await new Function('return import("/src/stores/codexWorkspace.ts")')();
    const runtime = window as any;
    runtime.__delayAttachment = true;
    const sending = useCodexWorkspace.getState().send('旧账号要求', [{ name: 'x.png', type: 'image/png', size: 1, dataUrl: 'data:image/png;base64,YQ==' }]).catch((error: Error) => error.message);
    while (!runtime.__releaseAttachment) await new Promise((resolve) => setTimeout(resolve, 0));
    useCodexWorkspace.getState().hydrate('new-account');
    useCodexWorkspace.setState({ workspaceRoot: 'D:/new-project', activeThreadId: 'a' });
    await useCodexWorkspace.getState().connect({ refreshThreads: false });
    runtime.__releaseAttachment();
    const error = await sending;
    return { error, dispatched: runtime.__actualDispatches.length, messages: useCodexWorkspace.getState().messages.length };
  });
  expect(outcome.error).toContain('账号已切换');
  expect(outcome.dispatched).toBe(0);
  expect(outcome.messages).toBe(0);
});

test('new-thread identity survives a failed thread refresh and stays retryable in that thread', async ({ page }) => {
  await bootAuthenticated(page);
  await mountComposer(page, 'butler');
  await installRealSendRuntime(page);
  await page.evaluate(async () => {
    const { useCodexWorkspace } = await new Function('return import("/src/stores/codexWorkspace.ts")')();
    useCodexWorkspace.setState({ activeThreadId: undefined });
    (window as any).__failThreadRefresh = true;
  });
  const host = page.locator('#composer-under-test');
  await host.locator('textarea').fill('新会话要求');
  await host.locator('textarea').press('Enter');
  await expect(host.getByRole('alert')).toContainText('会话列表刷新失败');
  expect(await page.evaluate(async () => {
    const { useCodexWorkspace } = await new Function('return import("/src/stores/codexWorkspace.ts")')();
    return useCodexWorkspace.getState().activeThreadId;
  })).toBe('created-thread');
  await host.locator('textarea').fill('下一条草稿');
  await expect(host.getByRole('button', { name: '重试原请求' })).toBeEnabled();
  await host.getByRole('button', { name: '重试原请求' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__actualDispatches.map((entry: any) => entry.threadId))).toEqual(['created-thread']);
  await expect(host.locator('textarea')).toHaveValue('下一条草稿');
});

test('late thread-list refresh cannot populate a different account', async ({ page }) => {
  await bootAuthenticated(page);
  await mountComposer(page, 'butler');
  await installRealSendRuntime(page);
  const result = await page.evaluate(async () => {
    const { useCodexWorkspace } = await new Function('return import("/src/stores/codexWorkspace.ts")')();
    const runtime = window as any;
    runtime.__delayThreadRefresh = true;
    const refreshing = useCodexWorkspace.getState().refreshThreads();
    while (!runtime.__releaseThreadRefresh) await new Promise((resolve) => setTimeout(resolve, 0));
    useCodexWorkspace.getState().hydrate('other-account');
    runtime.__releaseThreadRefresh();
    await refreshing;
    return useCodexWorkspace.getState().threads;
  });
  expect(result).toEqual([]);
});
