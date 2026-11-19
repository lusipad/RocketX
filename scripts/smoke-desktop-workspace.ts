/**
 * Real Tauri / WebView2 workspace persistence smoke. It attaches to an explicitly
 * isolated acceptance build; it never starts, closes, or kills a desktop process.
 *
 * pnpm exec tsx scripts/smoke-desktop-workspace.ts --phase seed --endpoint http://127.0.0.1:9339
 * pnpm exec tsx scripts/smoke-desktop-workspace.ts --phase verify --endpoint http://127.0.0.1:9339
 *
 * Run verify again after a native tray hide/show and after restarting the isolated
 * process. No credentials, external writes, AI turns, or production data are used.
 * WebView2 CDP: https://playwright.dev/docs/webview2
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  function option(name: string, fallback: string): string {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? fallback : fallback;
  }

  const phase = option('--phase', 'verify');
  assert(['seed', 'verify', 'show', 'ime-arm', 'ime-report', 'voice'].includes(phase), 'phase must be seed, verify, show, ime-arm, ime-report, or voice');
  const endpoint = new URL(option('--endpoint', 'http://127.0.0.1:9339'));
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), 'CDP must be loopback');
  const logDir = path.resolve(option('--output', '.omx/logs/rocketx-final-acceptance-20261115'));
  const manifestPath = path.join(logDir, 'desktop-workspace-manifest.json');
  await mkdir(logDir, { recursive: true });

  interface WorkCard {
    id: string;
    title: string;
    state: {
      goal: string;
      acceptance: string[];
      requirementsVersion: number;
      contentVersion: number;
      waitState: string;
      waitReason?: string;
      stage: string;
    };
  }
  interface Manifest {
    identifier: string;
    appDataDir: string;
    requestId: string;
    card: WorkCard;
    seededAt: string;
  }

  const browser = await chromium.connectOverCDP(endpoint.toString());
  try {
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages.find((candidate) => /tauri\.localhost|^tauri:\/\//.test(candidate.url()));
    assert(page, 'No real Tauri application page found. A browser preview is not sufficient.');
    page.setDefaultTimeout(15_000);
    await page.waitForFunction(() => Boolean((window as any).__TAURI_INTERNALS__?.invoke));

    async function invoke<T>(command: string, params: Record<string, unknown> = {}): Promise<T> {
      return page!.evaluate(({ command, params }) => (window as any).__TAURI_INTERNALS__.invoke(command, params), { command, params });
    }

    const identifier = await invoke<string>('plugin:app|identifier');
    assert(/^com\.lusipad\.rocketx\.acceptance[\w.-]+$/.test(identifier), 'Refusing to mutate a non-acceptance application');
    // Tauri BaseDirectory.AppData = 14. Check the native path independently from
    // the identifier before admitting any database writes.
    const appDataDir = await invoke<string>('plugin:path|resolve_directory', { directory: 14 });
    assert(appDataDir.toLowerCase().includes(identifier.toLowerCase()), 'Native appData directory is not isolated');
    assert.notEqual(path.basename(appDataDir).toLowerCase(), 'com.lusipad.rocketx');
    await invoke('set_tray_tooltip', { tooltip: `RocketX Acceptance (${identifier})` });

    if (phase === 'show') {
      await invoke('show_main_window');
      const visible = await invoke<boolean>('plugin:window|is_visible', { label: 'main' });
      assert.equal(visible, true, 'The isolated native main window was not shown');
      console.log(JSON.stringify({ phase, identifier, appDataDir, visible, checkedAt: new Date().toISOString() }, null, 2));
      return;
    }

    if (phase === 'ime-arm') {
      await page.evaluate(String.raw`(() => {
        const probeWindow = window;
        probeWindow.__rocketxDesktopImeProbe?.dispose();
        const counts = {};
        const enterEvents = [];
        const targetLabels = new Set();
        const names = ['compositionstart', 'compositionend', 'beforeinput', 'input', 'keydown'];
        const handle = (event) => {
          if (!(event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement)) return;
          counts[event.type] = (counts[event.type] ?? 0) + 1;
          const label = event.target.getAttribute('aria-label') || event.target.getAttribute('placeholder') || event.target.tagName;
          targetLabels.add(label);
          if (event instanceof KeyboardEvent && event.key === 'Enter') {
            queueMicrotask(() => enterEvents.push({ composing: event.isComposing, keyCode: event.keyCode, prevented: event.defaultPrevented }));
          }
        };
        for (const name of names) window.addEventListener(name, handle, true);
        probeWindow.__rocketxDesktopImeProbe = {
          counts, enterEvents, targetLabels,
          dispose() { for (const name of names) window.removeEventListener(name, handle, true); },
        };
      })()`);
      console.log('Native IME observation armed. Use the Windows IME in the isolated RocketX textarea, then run --phase ime-report. No text or typed characters are recorded.');
      return;
    }

    if (phase === 'ime-report') {
      const evidence = await page.evaluate(() => {
        const probe = (window as any).__rocketxDesktopImeProbe;
        if (!probe) return null;
        probe.dispose();
        const composer = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="给 Pi 的任务"]');
        return { counts: probe.counts, enterEvents: probe.enterEvents, targetLabels: [...probe.targetLabels],
          hasChineseText: /[\u3400-\u9fff]/.test(composer?.value ?? '') };
      });
      assert(evidence, 'No IME observation exists in this WebView document');
      const report = { checkedAt: new Date().toISOString(), identifier, ...evidence };
      await writeFile(path.join(logDir, 'desktop-ime-observation.json'), JSON.stringify(report, null, 2));
      assert(evidence.counts.compositionstart > 0 && evidence.counts.compositionend > 0 && evidence.counts.input > 0,
        'No complete native IME composition observed; pasted text is not an IME verification');
      assert(evidence.hasChineseText, 'Native composition events were observed, but Chinese candidate selection was not completed');
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    if (phase === 'voice') {
      const capabilities = await invoke<{ available: boolean; recognizers: unknown[]; voices: unknown[] }>('local_voice_probe', { requestId: randomUUID() });
      assert(capabilities.available, 'Installed offline speech engines are unavailable');
      const errors: Record<string, string> = {};
      for (const [command, params] of [
        ['local_voice_transcribe', { audioBase64: 'invalid-base64', language: 'zh-CN', requestId: randomUUID() }],
        ['local_voice_synthesize', { text: '', language: 'zh-CN', requestId: randomUUID() }],
      ] as const) {
        try { await invoke(command, params); }
        catch (error) { errors[command] = String(error); }
        assert(errors[command] && !/missing required|not found|unknown command/i.test(errors[command]), `${command} must return a business validation error`);
      }
      const audio = await invoke<{ audioBase64: string; mimeType: string; language: string }>('local_voice_synthesize', {
        text: '你好请继续完成今天的工作', language: 'zh-CN', requestId: randomUUID(),
      });
      const bytes = Buffer.from(audio.audioBase64, 'base64');
      assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF');
      assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WAVE');
      const transcript = await invoke<{ text: string; language: string; durationMs: number }>('local_voice_transcribe', {
        audioBase64: audio.audioBase64, language: 'zh-CN', requestId: randomUUID(),
      });
      assert(transcript.text.trim().length > 0, 'The real offline recognizer returned no text');
      assert.equal(transcript.language, 'zh-CN');
      assert(transcript.durationMs > 0);
      const evidence = {
        checkedAt: new Date().toISOString(), identifier, recognizers: capabilities.recognizers.length,
        voices: capabilities.voices.length, validationErrors: errors,
        wavBytes: bytes.length, mimeType: audio.mimeType,
        recognizedCharacters: transcript.text.trim().length, language: transcript.language, durationMs: transcript.durationMs,
        actualNativeIpc: 'passed', silentOfflineRoundtrip: 'passed', microphoneUsed: false, speakerUsed: false,
      };
      await writeFile(path.join(logDir, 'desktop-voice-ipc.json'), JSON.stringify(evidence, null, 2));
      console.log(JSON.stringify(evidence, null, 2));
      return;
    }

    async function snapshot(): Promise<{ cards: WorkCard[] }> {
      return invoke('butler_work_ledger_snapshot');
    }

    async function showCard(card: WorkCard): Promise<void> {
      const sidebar = page!.getByRole('navigation', { name: 'AI 协作' });
      if (await sidebar.count() === 0) {
        const nav = page!.getByRole('navigation', { name: 'RocketX 主导航' }).getByRole('button', { name: /^(AI )?管家$/ });
        if (await nav.count() > 0) await nav.first().click();
      }
      await sidebar.getByRole('button', { name: /^工作台/ }).click();
      const search = page!.getByPlaceholder('工作标题、ADO 编号、会话 ID、成果文件名…');
      await search.fill('');
      await search.fill(card.title);
      await page!.getByRole('list', { name: '检索结果' }).getByRole('button').filter({ hasText: card.title }).first().click();
      const editor = page!.locator('details').filter({ has: page!.locator('summary', { hasText: '编辑目标与下一步' }) });
      if (await editor.getAttribute('open') === null) await editor.locator('summary').click();
      const goal = editor.getByPlaceholder('明确这张卡片最终要收敛的交付目标…');
      await goal.waitFor({ state: 'visible' });
      assert.equal(await goal.inputValue(), card.state.goal, 'The visible work portal loaded a different goal');
    }

    let manifest: Manifest;
    if (phase === 'seed') {
      const owner = await page.evaluate(() => localStorage.getItem('rcx-owner'));
      assert.equal(owner, 'local-user@local', 'Acceptance must run in local mode without a production account');
      const requestId = `desktop-workspace-${Date.now()}`;
      const created = await invoke<WorkCard>('butler_work_card_create', { input: {
        requestId,
        title: `桌面生命周期验收 ${requestId}`,
        goal: '同一工作经过 WebView 重载、托盘隐藏及进程重启后仍保留原身份和验收条件。',
        acceptance: ['重载后工作 ID 不变', '进程重启后需求版本与等待原因保持'],
        ownerKind: 'human',
        autonomyMode: 'confirm',
        visibility: 'private',
        enroll: true,
      } });
      const card = await invoke<WorkCard>('butler_work_card_update', { id: created.id, patch: {
        waitState: 'paused', waitReason: '隔离桌面验收记录，不启动执行器。',
      } });
      manifest = { identifier, appDataDir, requestId, card, seededAt: new Date().toISOString() };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
      await page.reload({ waitUntil: 'domcontentloaded' });
    } else {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      assert.equal(identifier, manifest.identifier, 'Acceptance application changed');
      assert.equal(appDataDir, manifest.appDataDir, 'Acceptance appData changed');
    }

    async function recoverCard(): Promise<WorkCard> {
      const result = (await snapshot()).cards.find((card) => card.id === manifest.card.id);
      assert(result, 'Original work ID was not recovered from native SQLite');
      assert.equal(result.title, manifest.card.title);
      for (const key of ['goal', 'requirementsVersion', 'contentVersion', 'waitState', 'waitReason', 'stage'] as const) {
        assert.equal(result.state[key], manifest.card.state[key], `Work ${key} changed unexpectedly`);
      }
      assert.deepEqual(result.state.acceptance, manifest.card.state.acceptance);
      return result;
    }
    let result = await recoverCard();
    await showCard(result);
    if (phase === 'seed') {
      const nextGoal = `${result.state.goal}（已在真实 WebView 保存。）`;
      await page.getByPlaceholder('明确这张卡片最终要收敛的交付目标…').fill(nextGoal);
      await page.getByRole('button', { name: '保存简报', exact: true }).click();
      await expect.poll(async () => (await snapshot()).cards.find((card) => card.id === result.id)?.state.goal,
        { message: 'The visible portal must save through the real frontend wrapper and native IPC' }).toBe(nextGoal);
      const saved = (await snapshot()).cards.find((card) => card.id === result.id)!;
      assert.equal(saved.state.requirementsVersion, result.state.requirementsVersion + 1);
      manifest.card = saved;
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
      await page.reload({ waitUntil: 'domcontentloaded' });
      result = await recoverCard();
      await showCard(result);
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    await page.screenshot({ path: path.join(logDir, `desktop-workspace-${phase}-${timestamp}.png`) });
    const evidence = {
      phase, checkedAt: new Date().toISOString(), identifier, appDataDir,
      workId: result.id, requirementsVersion: result.state.requirementsVersion,
      contentVersion: result.state.contentVersion, waitState: result.state.waitState,
      nativeSqlite: 'passed', actualWebView: 'passed', pageUrl: page.url(),
      limitations: ['No OS sleep was performed', 'Native tray interactions are verified separately'],
    };
    await writeFile(path.join(logDir, `desktop-workspace-${phase}-${timestamp}.json`), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    // For a browser attached over CDP this disconnects Playwright; the native
    // process lifecycle remains under the caller's control.
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
