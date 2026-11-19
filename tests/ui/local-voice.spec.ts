import { expect, test, type Page } from '@playwright/test';
import { bootAuthenticated } from './support/rocket-chat-mock';

async function mountVoice(page: Page, kind: 'butler' | 'acp' = 'butler'): Promise<void> {
  await page.evaluate(async (composerKind) => {
    const load = (path: string) => new Function(`return import(${JSON.stringify(path)})`)();
    const [reactModule, reactDomModule, { useCodexWorkspace }, { useUI }, { useLocalVoice }, { useAcpAgents }, component] = await Promise.all([
      load('/node_modules/.vite/deps/react.js'), load('/node_modules/.vite/deps/react-dom_client.js'),
      load('/src/stores/codexWorkspace.ts'), load('/src/stores/ui.ts'), load('/src/stores/localVoice.ts'),
      load('/src/stores/acpAgents.ts'),
      load(composerKind === 'butler' ? '/src/components/ButlerConversation.tsx' : '/src/components/AcpWorkspaceSurface.tsx'),
    ]);
    const runtime = window as any;
    runtime.__voiceCalls = [];
    runtime.__voiceMicrophones = 0;
    runtime.__voiceTracksStopped = 0;
    runtime.__voiceDecoderClosed = 0;
    runtime.__voicePlaybackPaused = 0;
    runtime.__voicePlaybackStarted = 0;
    runtime.__voiceSendCount = 0;
    runtime.__voiceDeferred = false;
    runtime.__voicePermissionDenied = false;
    runtime.__voicePermissionDeferred = false;
    runtime.__voiceSynthesisDeferred = false;
    runtime.__voiceUnavailable = false;
    runtime.__voiceProbeDeferred = false;
    runtime.__voiceProbeResolvers = [];
    runtime.__voiceResolve = undefined;
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {
      invoke: async (command: string, args: unknown) => {
        if (!command.startsWith('local_voice_')) return null;
        runtime.__voiceCalls.push({ command, args });
        if (command === 'local_voice_cancel') return true;
        if (command === 'local_voice_probe' && runtime.__voiceProbeDeferred) return new Promise((resolve) => { runtime.__voiceProbeResolvers.push(resolve); });
        if (command === 'local_voice_probe') return runtime.__voiceUnavailable
          ? { available: false, platform: 'windows', recognizers: [], voices: [], reason: '未安装本地语音组件' }
          : { available: true, platform: 'windows', recognizers: [{ id: 'zh', language: 'zh-CN', name: '本地中文' }], voices: [{ id: 'huihui', language: 'zh-CN', name: 'Huihui' }] };
        if (command === 'local_voice_transcribe') {
          if (runtime.__voiceDeferred) return new Promise((resolve) => { runtime.__voiceResolve = resolve; });
          return { text: '请继续原来的工作', language: 'zh-CN', durationMs: 1000 };
        }
        if (runtime.__voiceSynthesisDeferred) return new Promise((resolve) => { runtime.__voiceSynthesisResolve = resolve; });
        return { audioBase64: 'UklGRg==', mimeType: 'audio/wav', language: 'zh-CN' };
      }, transformCallback: () => 0, unregisterCallback: () => {},
    } });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => {
      runtime.__voiceMicrophones += 1;
      if (runtime.__voicePermissionDenied) throw new DOMException('permission denied', 'NotAllowedError');
      const stream = { getTracks: () => [{ stop: () => { runtime.__voiceTracksStopped += 1; } }] };
      if (runtime.__voicePermissionDeferred) return new Promise((resolve) => { runtime.__voicePermissionResolve = () => resolve(stream); });
      return stream;
    } } });
    runtime.MediaRecorder = class {
      state = 'inactive'; mimeType = 'audio/webm'; ondataavailable: any; onstop: any;
      start() { this.state = 'recording'; }
      stop() {
        this.state = 'inactive';
        queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['local audio']) }); this.onstop?.(); });
      }
    };
    runtime.AudioContext = class {
      decodeAudioData = async () => ({ numberOfChannels: 1, sampleRate: 16_000, getChannelData: () => new Float32Array(16_000) });
      close = async () => { runtime.__voiceDecoderClosed += 1; };
    };
    runtime.Audio = class {
      onended: any; onerror: any;
      play = async () => { runtime.__voicePlaybackStarted += 1; };
      pause = () => { runtime.__voicePlaybackPaused += 1; };
      removeAttribute() {} load() {}
    };
    useLocalVoice.setState({ enabled: false });
    useUI.setState({ aiRuntimeProvider: 'pi', butlerSidebarCollapsed: true });
    useCodexWorkspace.setState({
      scope: 'voice-account', workspaceRoot: 'D:/voice', workspaceRoots: ['D:/voice'],
      activeThreadId: 'voice-a', status: 'ready', threads: [],
      messages: [{ id: 'reply', role: 'assistant', text: '原会话的可见回复' }], events: [], pendingRequests: [], queuedMessages: [], streamingText: '',
      send: async () => { runtime.__voiceSendCount += 1; },
    });
    const session = (key: string) => ({
      sessionKey: key, agentId: 'voice-agent', agentName: 'Local Agent', workspaceRoot: 'D:/voice',
      acpSessionId: key, status: 'ready', availableCommands: [], availableModes: [],
      messages: [], plan: [], toolCalls: [], pendingPermissions: [], streamingText: '',
      streamingThought: '', stderrLogs: [], modes: null, models: null,
      title: key, linkedTodoId: null, autonomyMode: 'confirm', turnCount: 0, createdAt: Date.now(), updatedAt: Date.now(),
    });
    useAcpAgents.setState({
      agents: [{ id: 'voice-agent', name: 'Local Agent', preset: 'custom', args: [], enabled: true }],
      sessions: { 'voice-a': session('voice-a'), 'voice-b': session('voice-b') }, activeSessionKey: 'voice-a',
      hydrate: async () => {}, discoverLocalSessions: async () => [],
      sendPrompt: async () => { runtime.__voiceSendCount += 1; },
    });
    runtime.__selectVoice = (target: string, scope = 'voice-account') => {
      useCodexWorkspace.setState({ activeThreadId: target, scope, messages: [] });
      useAcpAgents.setState({ activeSessionKey: target });
    };
    document.querySelector<HTMLElement>('#root')!.style.display = 'none';
    const host = document.createElement('div');
    host.id = 'voice-under-test'; host.style.cssText = 'height:100vh;display:flex;flex-direction:column';
    document.body.append(host);
    const React = reactModule.default ?? reactModule;
    const { createRoot } = reactDomModule.default ?? reactDomModule;
    const root = createRoot(host);
    runtime.__unmountVoice = () => root.unmount();
    root.render(React.createElement(component.default));
  }, kind);
  await expect(page.locator('#voice-under-test textarea')).toBeEditable();
  if (kind === 'butler') await page.locator('#voice-under-test .work-first-composer-voice > summary').click();
}

async function holdAndRelease(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: '按住说话', exact: true });
  await button.focus();
  await page.keyboard.down('Space');
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.up('Space');
}

test('local voice stays off until opt-in, transcribes into editable draft and never sends', async ({ page }) => {
  await bootAuthenticated(page); await mountVoice(page);
  expect(await page.evaluate(() => ({ calls: (window as any).__voiceCalls, microphones: (window as any).__voiceMicrophones }))).toEqual({ calls: [], microphones: 0 });
  const input = page.locator('#voice-under-test textarea');
  await input.fill('已有文字');
  await page.getByRole('button', { name: '启用本地语音（可选）' }).click();
  await expect(page.getByRole('button', { name: '按住说话', exact: true })).toBeEnabled();
  await holdAndRelease(page);
  await expect(input).toHaveValue('已有文字\n请继续原来的工作');
  await expect(page.getByRole('status').filter({ hasText: '转写已填入草稿，可编辑后发送。' })).toBeVisible();
  await input.fill('我修改后的语音要求');
  expect(await page.evaluate(() => (window as any).__voiceSendCount)).toBe(0);
  const calls = await page.evaluate(() => (window as any).__voiceCalls);
  expect(calls.map((call: any) => call.command)).toEqual(['local_voice_probe', 'local_voice_transcribe']);
  expect(calls[1].args.language).toBe('zh-CN');
  expect(Buffer.from(calls[1].args.audioBase64, 'base64').subarray(0, 4).toString()).toBe('RIFF');
  expect(await page.evaluate(() => (window as any).__voiceTracksStopped)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).__voiceDecoderClosed)).toBeGreaterThan(0);
});

test('switching recipient or account discards late recognition and closes local voice', async ({ page }) => {
  await bootAuthenticated(page); await mountVoice(page);
  await page.evaluate(() => { (window as any).__voiceDeferred = true; });
  await page.getByRole('button', { name: '启用本地语音（可选）' }).click();
  await expect(page.getByRole('button', { name: '按住说话', exact: true })).toBeEnabled();
  await holdAndRelease(page);
  await expect.poll(() => page.evaluate(() => typeof (window as any).__voiceResolve)).toBe('function');
  await page.evaluate(() => (window as any).__selectVoice('voice-b', 'second-account'));
  const input = page.locator('#voice-under-test textarea');
  await input.fill('新账号的新要求');
  await page.evaluate(() => (window as any).__voiceResolve({ text: '迟到的私有语音', language: 'zh-CN', durationMs: 1000 }));
  await expect(input).toHaveValue('新账号的新要求');
  const requests = await page.evaluate(() => (window as any).__voiceCalls);
  const original = requests.find((call: any) => call.command === 'local_voice_transcribe');
  expect(requests.filter((call: any) => call.command === 'local_voice_cancel').map((call: any) => call.args.requestId)).toEqual([original.args.requestId]);
  await expect(page.getByRole('button', { name: '启用本地语音（可选）' })).toBeVisible();
  await page.evaluate(() => (window as any).__selectVoice('voice-a'));
  await expect(input).toHaveValue('');
  expect(await page.evaluate(() => (window as any).__voiceSendCount)).toBe(0);
});

test('blur and close stop the microphone; permission failure can be retried', async ({ page }) => {
  await bootAuthenticated(page); await mountVoice(page);
  await page.evaluate(() => { (window as any).__voicePermissionDenied = true; });
  await page.getByRole('button', { name: '启用本地语音（可选）' }).click();
  const button = page.getByRole('button', { name: '按住说话', exact: true });
  await expect(button).toBeEnabled();
  await button.focus(); await page.keyboard.down('Space'); await page.keyboard.up('Space');
  await expect(page.getByRole('alert').filter({ hasText: '麦克风权限未允许' })).toBeVisible();
  await page.evaluate(() => { (window as any).__voicePermissionDenied = false; });
  await button.focus(); await page.keyboard.down('Space');
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.keyboard.up('Space');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => (window as any).__voiceTracksStopped)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).__voiceCalls.filter((call: any) => call.command === 'local_voice_transcribe').length)).toBe(0);
  await button.focus(); await page.keyboard.down('Space');
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '关闭本地语音' }).click();
  await page.keyboard.up('Space');
  await expect(page.getByRole('button', { name: '启用本地语音（可选）' })).toBeVisible();
});

test('收起语音面板会停止录音和朗读，控件隐藏后不留后台媒体', async ({ page }) => {
  await bootAuthenticated(page); await mountVoice(page);
  await page.getByRole('button', { name: '启用本地语音（可选）' }).click();
  const hold = page.getByRole('button', { name: '按住说话', exact: true });
  await expect(hold).toBeEnabled();
  await hold.focus(); await page.keyboard.down('Space');
  await expect(hold).toHaveAttribute('aria-pressed', 'true');
  const panel = page.locator('#voice-under-test .work-first-composer-voice');
  await panel.locator('summary').click();
  await page.keyboard.up('Space');
  await expect(panel.getByRole('button', { name: '按住说话' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__voiceTracksStopped)).toBeGreaterThan(0);
  await panel.locator('summary').click();
  await page.getByRole('button', { name: '朗读最新回复', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__voicePlaybackStarted)).toBe(1);
  await panel.locator('summary').click();
  await expect.poll(() => page.evaluate(() => (window as any).__voicePlaybackPaused)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).__voiceSendCount)).toBe(0);
});

test('manual local readout stops on switching work and never interrupts a task', async ({ page }) => {
  await bootAuthenticated(page); await mountVoice(page);
  expect(await page.evaluate(() => (window as any).__voicePlaybackStarted)).toBe(0);
  await page.getByRole('button', { name: '启用本地语音（可选）' }).click();
  await page.getByRole('button', { name: '朗读最新回复', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__voicePlaybackStarted)).toBe(1);
  await page.getByRole('button', { name: '停止语音' }).click();
  expect(await page.evaluate(() => (window as any).__voicePlaybackPaused)).toBe(1);
  await page.getByRole('button', { name: '朗读最新回复', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__voicePlaybackStarted)).toBe(2);
  await page.evaluate(() => (window as any).__selectVoice('voice-b'));
  await expect.poll(() => page.evaluate(() => (window as any).__voicePlaybackPaused)).toBe(2);
  expect(await page.evaluate(() => (window as any).__voiceCalls.some((call: any) => call.command.includes('interrupt')))).toBe(false);
});

test('thirty-second cap finishes recording; unmount closes every live resource', async ({ page }) => {
  await bootAuthenticated(page); await mountVoice(page);
  await page.clock.install();
  await page.getByRole('button', { name: '启用本地语音（可选）' }).click();
  const button = page.getByRole('button', { name: '按住说话', exact: true });
  await expect(button).toBeEnabled();
  await button.focus(); await page.keyboard.down('Space');
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await page.clock.fastForward(30_000);
  await expect(page.locator('#voice-under-test textarea')).toHaveValue('请继续原来的工作');
  await page.keyboard.up('Space');
  await button.focus(); await page.keyboard.down('Space');
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  const before = await page.evaluate(() => (window as any).__voiceTracksStopped);
  await page.evaluate(() => (window as any).__unmountVoice());
  expect(await page.evaluate(() => (window as any).__voiceTracksStopped)).toBeGreaterThan(before);
});

test('a microphone permission grant or synthesis arriving after a switch is discarded', async ({ page }) => {
  await bootAuthenticated(page); await mountVoice(page);
  await page.evaluate(() => { (window as any).__voicePermissionDeferred = true; });
  await page.getByRole('button', { name: '启用本地语音（可选）' }).click();
  const button = page.getByRole('button', { name: '按住说话', exact: true });
  await expect(button).toBeEnabled();
  await button.focus(); await page.keyboard.down('Space');
  await expect.poll(() => page.evaluate(() => typeof (window as any).__voicePermissionResolve)).toBe('function');
  await page.evaluate(() => (window as any).__selectVoice('voice-b'));
  await page.keyboard.up('Space');
  await page.evaluate(() => (window as any).__voicePermissionResolve());
  await expect.poll(() => page.evaluate(() => (window as any).__voiceTracksStopped)).toBe(1);
  expect(await page.evaluate(() => (window as any).__voiceCalls.some((call: any) => call.command === 'local_voice_transcribe'))).toBe(false);
  await page.evaluate(async () => {
    const { useCodexWorkspace } = await new Function('return import("/src/stores/codexWorkspace.ts")')();
    useCodexWorkspace.setState({ messages: [{ id: 'new-reply', role: 'assistant', text: '新的私有回复' }] });
    (window as any).__voiceSynthesisDeferred = true;
  });
  await page.getByRole('button', { name: '启用本地语音（可选）' }).click();
  await page.getByRole('button', { name: '朗读最新回复', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__voiceSynthesisResolve)).toBe('function');
  await page.evaluate(() => (window as any).__selectVoice('voice-c'));
  await page.evaluate(() => (window as any).__voiceSynthesisResolve({ audioBase64: 'UklGRg==', mimeType: 'audio/wav', language: 'zh-CN' }));
  expect(await page.evaluate(() => (window as any).__voicePlaybackStarted)).toBe(0);
  const requests = await page.evaluate(() => (window as any).__voiceCalls);
  const synthesis = requests.find((call: any) => call.command === 'local_voice_synthesize');
  expect(requests.filter((call: any) => call.command === 'local_voice_cancel').map((call: any) => call.args.requestId)).toEqual([synthesis.args.requestId]);
});

test('browser-only use advertises unavailable without microphone or native calls', async ({ page }) => {
  await bootAuthenticated(page); await mountVoice(page);
  await page.evaluate(async () => {
    delete (window as any).__TAURI_INTERNALS__;
    (window as any).__selectVoice('browser-target');
  });
  await expect(page.getByText('本地语音仅支持桌面客户端', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => ({ calls: (window as any).__voiceCalls, microphones: (window as any).__voiceMicrophones }))).toEqual({ calls: [], microphones: 0 });
});

test('missing local language components leaves text work available and can be checked again', async ({ page }) => {
  await bootAuthenticated(page); await mountVoice(page);
  await page.evaluate(() => { (window as any).__voiceUnavailable = true; });
  await page.getByRole('button', { name: '启用本地语音（可选）' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '未安装本地语音组件' })).toBeVisible();
  await expect(page.getByRole('button', { name: '按住说话', exact: true })).toBeDisabled();
  const input = page.locator('#voice-under-test textarea');
  await input.fill('文字功能继续正常工作'); await input.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__voiceSendCount)).toBe(1);
  expect(await page.evaluate(() => (window as any).__voiceMicrophones)).toBe(0);
  await page.evaluate(() => { (window as any).__voiceUnavailable = false; });
  await page.getByRole('button', { name: '重新检查本地语音' }).click();
  await expect(page.getByRole('button', { name: '按住说话', exact: true })).toBeEnabled();
});

test('ACP uses the same optional voice control and preserves edits made during recognition', async ({ page }) => {
  await bootAuthenticated(page); await mountVoice(page, 'acp');
  await page.evaluate(() => { (window as any).__voiceDeferred = true; });
  await page.getByRole('button', { name: '启用本地语音（可选）' }).click();
  await expect(page.getByRole('button', { name: '按住说话', exact: true })).toBeEnabled();
  await holdAndRelease(page);
  await expect.poll(() => page.evaluate(() => typeof (window as any).__voiceResolve)).toBe('function');
  const input = page.locator('#voice-under-test textarea');
  await input.fill('识别期间补充的要求');
  await page.evaluate(() => (window as any).__voiceResolve({ text: '原始语音转写', language: 'zh-CN', durationMs: 1000 }));
  await expect(input).toHaveValue('识别期间补充的要求\n原始语音转写');
  expect(await page.evaluate(() => (window as any).__voiceSendCount)).toBe(0);
  await page.evaluate(() => (window as any).__selectVoice('voice-b'));
  await expect(input).toHaveValue('');
  await expect(page.getByRole('button', { name: '启用本地语音（可选）' })).toBeVisible();
});

test('closing a pending capability probe cancels only its request and old results cannot pollute re-enablement', async ({ page }) => {
  await bootAuthenticated(page); await mountVoice(page);
  await page.evaluate(() => { (window as any).__voiceProbeDeferred = true; });
  await page.getByRole('button', { name: '启用本地语音（可选）' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__voiceProbeResolvers.length)).toBe(1);
  const firstId = await page.evaluate(() => (window as any).__voiceCalls.find((call: any) => call.command === 'local_voice_probe')?.args?.requestId);
  expect(firstId).toBeTruthy();
  await page.getByRole('button', { name: '关闭本地语音' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__voiceCalls.filter((call: any) => call.command === 'local_voice_cancel').map((call: any) => call.args.requestId))).toEqual([firstId]);
  await page.getByRole('button', { name: '启用本地语音（可选）' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__voiceProbeResolvers.length)).toBe(2);
  const secondId = await page.evaluate(() => (window as any).__voiceCalls.filter((call: any) => call.command === 'local_voice_probe')[1].args.requestId);
  expect(secondId).not.toBe(firstId);
  await page.evaluate(() => (window as any).__voiceProbeResolvers[0]({ available: false, platform: 'windows', recognizers: [], voices: [], reason: '旧请求的错误' }));
  await expect(page.getByRole('status').filter({ hasText: '正在检查本机语音组件' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: '旧请求的错误' })).toHaveCount(0);
  await page.getByRole('button', { name: '关闭本地语音' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__voiceCalls.filter((call: any) => call.command === 'local_voice_cancel').map((call: any) => call.args.requestId))).toEqual([firstId, secondId]);
  await page.evaluate(() => { (window as any).__voiceProbeDeferred = false; });
  await page.getByRole('button', { name: '启用本地语音（可选）' }).click();
  await expect(page.getByRole('button', { name: '按住说话', exact: true })).toBeEnabled();
  await page.evaluate(() => (window as any).__voiceProbeResolvers[1]({ available: false, platform: 'windows', recognizers: [], voices: [], reason: '第二次旧请求的错误' }));
  await expect(page.getByRole('button', { name: '按住说话', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__voiceMicrophones)).toBe(0);
});
