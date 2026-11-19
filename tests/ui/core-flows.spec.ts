import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { sandboxDocument } from '../../apps/web/src/kernel/sandbox/iframe';

const ME = {
  _id: 'user-me',
  username: 'tester',
  name: 'Test User',
  status: 'online',
  roles: ['admin'],
};
const ALICE = {
  _id: 'user-alice',
  username: 'alice',
  name: 'Alice',
  status: 'online',
  roles: ['user'],
};
const NOW = '2026-07-17T08:00:00.000Z';
const SERVER = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4173';
const RELEASE_DESKTOP_E2E = process.env.PLAYWRIGHT_RELEASE_MODE === '1';
// 一秒、32×24、纯红色的 H.264 Baseline 视频，专门验证下载后的容器和画面都可解码。
const PREVIEW_VIDEO = readFileSync('tests/ui/fixtures/preview-red.mp4');

async function expectPreviewVideoToPlay(page: Page) {
  const video = page.locator('video[controls]');
  await expect(video).toBeVisible();
  const mediaType = await video.evaluate(async (el: HTMLVideoElement) =>
    (await fetch(el.currentSrc || el.src)).headers.get('content-type'));
  expect(mediaType).toBe('video/mp4');
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) =>
    [el.videoWidth, el.videoHeight, el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA],
  )).toEqual([32, 24, true]);
  const pixel = await video.evaluate((el: HTMLVideoElement) => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;
    context.drawImage(el, 0, 0);
    return Array.from(context.getImageData(4, 4, 1, 1).data);
  });
  expect(pixel[0]).toBeGreaterThan(220);
  expect(pixel[1]).toBeLessThan(32);
  expect(pixel[2]).toBeLessThan(32);
  await video.evaluate(async (el: HTMLVideoElement) => {
    el.muted = true;
    await el.play();
  });
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime)).toBeGreaterThan(0.1);
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) =>
    el.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(1);
}

async function readStoredTodos(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => {
    const parsed: unknown = JSON.parse(localStorage.getItem('rcx-todos') ?? '[]');
    if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
    if (parsed && typeof parsed === 'object' && 'data' in parsed) {
      const data = (parsed as { data?: unknown }).data;
      if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
    }
    return [];
  });
}

async function installTauriMock(page: Page, workspaceConfig?: Record<string, unknown>) {
  await page.addInitScript(({ config }) => {
    let responseUrl = '';
    let responseBodySent = false;
    let accountGeneration = 0;
    let autostartEnabled = false;
    let notificationPermission: NotificationPermission = 'default';
    Object.defineProperty(window.Notification, 'permission', {
      configurable: true,
      get: () => notificationPermission,
    });
    Object.defineProperty(window.Notification, 'requestPermission', {
      configurable: true,
      value: async () => {
        notificationPermission = 'granted';
        return notificationPermission;
      },
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        metadata: {
          currentWindow: { label: 'main' },
          currentWebview: { label: 'main' },
        },
        invoke: async (command: string, args?: Record<string, any>) => {
          if (command === 'butler_db_select_account') {
            return { accountScope: args?.accountScope, generation: ++accountGeneration };
          }
          if (command === 'butler_todo_list') return [];
          if (command === 'allow_http_origin') return new URL(String(args?.origin)).origin;
          if (command === 'plugin:http|fetch') {
            responseUrl = String(args?.clientConfig?.url ?? '');
            return 1;
          }
          if (command === 'plugin:http|fetch_send') {
            responseBodySent = false;
            return { status: 200, statusText: 'OK', url: responseUrl, headers: [], rid: 2 };
          }
          if (command === 'plugin:http|fetch_read_body') {
            if (responseBodySent) return [1];
            responseBodySent = true;
            const body = responseUrl.endsWith('/api/info')
              ? { version: '8.6.1', success: true }
              : (config ?? { version: 1, rocketChat: { url: 'https://chat.example.com' } });
            return [...new TextEncoder().encode(JSON.stringify(body)), 0];
          }
          if (command === 'codex_runtime_probe') {
            return {
              ready: true,
              version: '0.145.0',
              executablePath: 'C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd',
              source: 'system',
              protocolBaseline: '0.144.4',
              minimumCandidate: '0.140.0',
              verifiedVersions: ['0.144.4'],
              compatibilityStatus: 'untested-newer',
            };
          }
          if (command === 'image_ocr_runtime_probe') {
            return {
              backend: 'windows-media-ocr',
              reason: '未安装增强 OCR 资源，当前使用 Windows.Media.Ocr；中文识别质量可能较低',
            };
          }
          if (command === 'mcp_config_status' || command === 'agent_bot_config_status') {
            return { enabled: false };
          }
          if (command === 'plugin:notification|is_permission_granted') {
            return notificationPermission === 'granted';
          }
          if (command === 'set_autostart_enabled') {
            autostartEnabled = Boolean(args?.enabled);
            return autostartEnabled;
          }
          if (command === 'read_autostart_enabled') return autostartEnabled;
          if (command === 'plugin:updater|check') return null;
          return null;
        },
        transformCallback: () => 0,
        unregisterCallback: () => {},
      },
    });
    Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
      configurable: true,
      value: { unregisterListener: () => {} },
    });
  }, { config: workspaceConfig });
}

async function installFullTauriMock(page: Page) {
  await page.addInitScript(() => {
    let nextRid = 1;
    let accountGeneration = 0;
    let piConfig = {
      provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat',
      extraModels: ['deepseek-reasoner'], hasApiKey: true, apiKeyHint: '••42',
    };
    const requests = new Map<number, { method: string; url: string; headers: string[][]; data?: number[] }>();
    const responses = new Map<number, { bytes: number[]; read: boolean }>();
    const normalizeFsPath = (value: string) => value.replace(/\//g, '\\').replace(/\\+/g, '\\').replace(/\\$/, '');
    const parentDir = (value: string) => {
      const normalized = normalizeFsPath(value);
      const index = normalized.lastIndexOf('\\');
      return index >= 0 ? normalized.slice(0, index) : '';
    };
    const baseName = (value: string) => {
      const normalized = normalizeFsPath(value);
      const index = normalized.lastIndexOf('\\');
      return index >= 0 ? normalized.slice(index + 1) : normalized;
    };
    const fileBytes = new Map<string, number[]>();
    const directories = new Set<string>();
    const ensureDir = (value: string) => {
      const normalized = normalizeFsPath(value);
      if (!normalized) return;
      directories.add(normalized);
      const parent = parentDir(normalized);
      if (parent && parent !== normalized) ensureDir(parent);
    };
    const writeFsFile = (path: string, bytes: number[]) => {
      const normalized = normalizeFsPath(path);
      fileBytes.set(normalized, [...bytes]);
      ensureDir(parentDir(normalized));
    };
    const listDir = (path: string) => {
      const normalized = normalizeFsPath(path);
      const seen = new Map<string, { name: string; isFile: boolean; isDirectory: boolean; path: string }>();
      for (const [filePath] of fileBytes) {
        if (parentDir(filePath) !== normalized) continue;
        const name = baseName(filePath);
        seen.set(name, { name, isFile: true, isDirectory: false, path: filePath });
      }
      for (const directoryPath of directories) {
        if (!directoryPath || directoryPath === normalized || parentDir(directoryPath) !== normalized) continue;
        const name = baseName(directoryPath);
        if (!seen.has(name)) {
          seen.set(name, { name, isFile: false, isDirectory: true, path: directoryPath });
        }
      }
      return [...seen.values()];
    };
    const calls: Array<{ command: string; args?: unknown; options?: Record<string, unknown> }> = [];
    (window as unknown as { __tauriCalls: typeof calls }).__tauriCalls = calls;
    (window as unknown as {
      __setMockFsFile?: (path: string, bytes: number[]) => void;
      __setMockFsDirectory?: (path: string) => void;
      __dialogOpenResponses?: Array<string | string[] | null>;
      __mockFsFiles?: Record<string, number[]>;
      __mockFsDirectories?: string[];
    }).__setMockFsFile = writeFsFile;
    (window as unknown as {
      __setMockFsFile?: (path: string, bytes: number[]) => void;
      __setMockFsDirectory?: (path: string) => void;
      __dialogOpenResponses?: Array<string | string[] | null>;
      __mockFsFiles?: Record<string, number[]>;
      __mockFsDirectories?: string[];
    }).__setMockFsDirectory = ensureDir;
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        metadata: {
          currentWindow: { label: 'main' },
          currentWebview: { label: 'main' },
        },
        invoke: async (command: string, args?: unknown, options?: Record<string, any>) => {
          calls.push({ command, args, options });
          const invokeArgs = (args && typeof args === 'object' && !ArrayBuffer.isView(args) && !Array.isArray(args))
            ? (args as Record<string, any>)
            : undefined;
          if (
            command === 'plugin:webview|set_webview_zoom' &&
            (window as unknown as { __failUiScale?: boolean }).__failUiScale
          ) {
            throw new Error('mock zoom failed');
          }
          if (command === 'butler_db_select_account') {
            return { accountScope: invokeArgs?.accountScope, generation: ++accountGeneration };
          }
          if (command === 'allow_http_origin') return new URL(String(invokeArgs?.origin)).origin;
          if (command === 'codex_default_workspace') return 'C:\\Users\\tester\\AppData\\Local\\com.lusipad.rocketx\\codex-projectless';
          if (command === 'codex_butler_workspace') return 'C:\\Users\\tester\\AppData\\Local\\com.lusipad.rocketx\\codex-butler';
          if (command === 'plugin:dialog|open') {
            const queue = (window as unknown as { __dialogOpenResponses?: Array<string | string[] | null> }).__dialogOpenResponses ?? [];
            return queue.length > 0 ? queue.shift() ?? null : null;
          }
          if (command === 'plugin:path|resolve_directory') return 'C:\\Users\\tester\\AppData\\Roaming\\com.lusipad.rocketx';
          if (command === 'plugin:path|join') return (invokeArgs?.paths ?? []).join('\\');
          if (command === 'download_history_open') {
            const failure = (window as unknown as { __failDownloadHistoryOpen?: string }).__failDownloadHistoryOpen;
            if (failure) throw failure;
            return null;
          }
          if (command === 'plugin:fs|mkdir') return null;
          if (command === 'plugin:fs|exists') {
            const path = normalizeFsPath(String(invokeArgs?.path ?? ''));
            return fileBytes.has(path) || directories.has(path);
          }
          if (command === 'plugin:fs|remove') {
            if ((window as unknown as { __failArchiveRemove?: boolean }).__failArchiveRemove) {
              throw new Error('mock remove failed');
            }
            const target = normalizeFsPath(String(invokeArgs?.path ?? ''));
            fileBytes.delete(target);
            directories.delete(target);
            return null;
          }
          if (command === 'plugin:fs|open') return 91;
          if (command === 'plugin:fs|write') return invokeArgs?.data?.byteLength ?? invokeArgs?.data?.length ?? 0;
          if (command === 'plugin:fs|write_file') {
            const path = decodeURIComponent(String(options?.headers?.path ?? invokeArgs?.headers?.path ?? ''));
            const data = Array.isArray(invokeArgs?.body)
              ? invokeArgs.body
              : args instanceof Uint8Array
                ? [...args]
                : args instanceof ArrayBuffer
                  ? [...new Uint8Array(args)]
                : Array.isArray(args)
                  ? args
                  : [];
            writeFsFile(path, data);
            return null;
          }
          if (command === 'plugin:fs|copy_file') {
            const fromPath = normalizeFsPath(String(invokeArgs?.fromPath ?? ''));
            const toPath = normalizeFsPath(String(invokeArgs?.toPath ?? ''));
            const existing = fileBytes.get(fromPath);
            if (!existing) throw new Error(`mock file not found: ${fromPath}`);
            writeFsFile(toPath, existing);
            return null;
          }
          if (command === 'plugin:fs|read_file') {
            const path = normalizeFsPath(String(invokeArgs?.path ?? ''));
            const bytes = fileBytes.get(path);
            if (!bytes) throw new Error(`mock file not found: ${path}`);
            return bytes;
          }
          if (command === 'plugin:fs|read_text_file') {
            const path = normalizeFsPath(String(invokeArgs?.path ?? ''));
            const bytes = fileBytes.get(path);
            if (!bytes) throw new Error(`mock file not found: ${path}`);
            return bytes;
          }
          if (command === 'plugin:fs|read_dir') {
            const path = normalizeFsPath(String(invokeArgs?.path ?? ''));
            return listDir(path);
          }
          if (command === 'plugin:resources|close') return null;
          if (command === 'plugin:fs|stat') {
            const path = normalizeFsPath(String(invokeArgs?.path ?? ''));
            const bytes = fileBytes.get(path);
            if (bytes) {
              return {
                isFile: true, isDirectory: false, isSymlink: false, size: bytes.length,
                mtime: null, atime: null, birthtime: null, readonly: false,
                fileAttributes: null, dev: null, ino: null, mode: null, nlink: null,
                uid: null, gid: null, rdev: null, blksize: null, blocks: null,
              };
            }
            if (directories.has(path)) {
              return {
                isFile: false, isDirectory: true, isSymlink: false, size: 0,
                mtime: null, atime: null, birthtime: null, readonly: false,
                fileAttributes: null, dev: null, ino: null, mode: null, nlink: null,
                uid: null, gid: null, rdev: null, blksize: null, blocks: null,
              };
            }
            return {
              isFile: true, isDirectory: false, isSymlink: false, size: 256,
              mtime: null, atime: null, birthtime: null, readonly: false,
              fileAttributes: null, dev: null, ino: null, mode: null, nlink: null,
              uid: null, gid: null, rdev: null, blksize: null, blocks: null,
            };
          }
          if (command === 'plugin:http|fetch') {
            const rid = nextRid++;
            requests.set(rid, args?.clientConfig);
            return rid;
          }
          if (command === 'plugin:http|fetch_send') {
            const request = requests.get(Number(args?.rid))!;
            const response = await fetch(request.url, {
              method: request.method,
              headers: request.headers,
              body: request.data ? new Uint8Array(request.data) : undefined,
            });
            const rid = nextRid++;
            responses.set(rid, { bytes: [...new Uint8Array(await response.arrayBuffer())], read: false });
            return {
              status: response.status,
              statusText: response.statusText,
              url: response.url,
              headers: [...response.headers.entries()],
              rid,
            };
          }
          if (command === 'plugin:http|fetch_read_body') {
            const response = responses.get(Number(args?.rid))!;
            if (response.read) return [1];
            response.read = true;
            return [...response.bytes, 0];
          }
          if (command === 'image_ocr_recognize') {
            return {
              text: 'RocketX 本地 OCR',
              language: 'zh-Hans',
              backend: 'pp-ocrv5',
              words: [
                { text: 'RocketX', x: 0.08, y: 0.2, width: 0.35, height: 0.18, spaceAfter: false },
                { text: '本地', x: 0.08, y: 0.55, width: 0.2, height: 0.18, spaceAfter: true },
                { text: 'OCR', x: 0.3, y: 0.55, width: 0.2, height: 0.18, spaceAfter: false },
              ],
            };
          }
          if (command === 'pi_runtime_probe') {
            return { ready: true, source: 'bundled', version: '1.5.0', nodeVersion: '22.19.0',
              packagePath: 'resources/pi-runtime', configuredProvider: piConfig.provider,
              defaultModel: piConfig.defaultModel, hasCredentials: piConfig.hasApiKey };
          }
          if (['acp_agent_list', 'acp_agent_discover', 'acp_process_list', 'acp_local_sessions_discover'].includes(command)) return [];
          if (command === 'pi_config_read') return piConfig;
          if (command === 'pi_config_write') {
            const { apiKey, ...input } = args?.input ?? {};
            piConfig = { ...piConfig, ...input, hasApiKey: apiKey === undefined ? piConfig.hasApiKey : !!apiKey };
            return piConfig;
          }
          if (command === 'codex_runtime_probe') {
            const probeWindow = window as Window & { __codexProbeCount?: number };
            probeWindow.__codexProbeCount = (probeWindow.__codexProbeCount ?? 0) + 1;
            return {
              ready: true,
              version: '0.145.0',
              executablePath: 'C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd',
              source: 'system',
              protocolBaseline: '0.144.4',
              minimumCandidate: '0.140.0',
              verifiedVersions: ['0.144.4'],
              compatibilityStatus: 'untested-newer',
              candidates: [
                {
                  source: 'standard',
                  path: 'C:\\Users\\tester\\AppData\\Roaming\\npm\\codex-old.cmd',
                  version: '0.144.1',
                  outcome: 'rejected',
                  reasonCode: 'outdated',
                },
                {
                  source: 'system',
                  path: 'C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd',
                  version: '0.145.0',
                  outcome: 'selected',
                },
              ],
            };
          }
          if (command === 'image_ocr_runtime_probe') {
            return {
              backend: 'windows-media-ocr',
              reason: '未安装增强 OCR 资源，当前使用 Windows.Media.Ocr；中文识别质量可能较低',
            };
          }
          if (command === 'mcp_config_status' || command === 'agent_bot_config_status') {
            return { enabled: false };
          }
          if (command === 'plugin:updater|check') return null;
          return null;
        },
        transformCallback: () => 0,
        unregisterCallback: () => {},
      },
    });
    Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
      configurable: true,
      value: { unregisterListener: () => {} },
    });
  });
}

function agentCardMessage(referenceAt = Date.now()) {
  const card = {
    version: 1,
    sessionId: 'session-agent-room',
    tmid: 'room:discussion-agent',
    hostUserId: ALICE._id,
    hostUsername: ALICE.username,
    hostDeviceId: 'device-alice',
    leaseExpiresAt: referenceAt + 60_000,
    environmentName: 'RocketChat X',
    workItem: { id: 128, project: 'RocketChatX', title: 'Login failure' },
    proposedBranch: 'ai/128-login-failure',
    status: 'active',
  };
  return `🤖 **AI 工作项会话：#128 Login failure**\n主持人：@alice · 状态：运行中\n<!--rocketx-agent:${encodeURIComponent(JSON.stringify(card))}-->`;
}

const discussionAgentLeaseCard = {
  _id: 'agent-lease-card',
  rid: 'discussion-agent',
  msg: agentCardMessage(),
  ts: NOW,
  u: ALICE,
};

const subscriptions = [
  {
    _id: 'sub-general',
    rid: 'room-general',
    t: 'c',
    name: 'general',
    fname: 'General',
    open: true,
    unread: 1,
    alert: true,
    ls: '2026-07-17T07:00:00.000Z',
  },
  {
    _id: 'sub-project',
    rid: 'room-project',
    t: 'c',
    name: 'project-alpha',
    fname: 'Project Alpha',
    open: true,
    unread: 0,
    alert: false,
    ls: NOW,
  },
  {
    _id: 'sub-discussion-agent',
    rid: 'discussion-agent',
    t: 'p',
    prid: 'room-general',
    name: '128-login-failure',
    fname: '#128 Login failure',
    open: true,
    unread: 0,
    alert: false,
    ls: NOW,
  },
];

const rooms = [
  {
    _id: 'room-general',
    t: 'c',
    name: 'general',
    fname: 'General',
    usersCount: 2,
    lm: NOW,
    lastMessage: {
      _id: 'general-release',
      rid: 'room-general',
      msg: 'Release checklist ready',
      ts: NOW,
      u: ALICE,
    },
  },
  {
    _id: 'room-project',
    t: 'c',
    name: 'project-alpha',
    fname: 'Project Alpha',
    usersCount: 2,
    lm: NOW,
    lastMessage: {
      _id: 'project-latest',
      rid: 'room-project',
      msg: 'Project plan updated',
      ts: NOW,
      u: ALICE,
    },
  },
  {
    _id: 'discussion-agent',
    t: 'p',
    prid: 'room-general',
    name: '128-login-failure',
    fname: '#128 Login failure',
    usersCount: 2,
    lm: NOW,
    lastMessage: discussionAgentLeaseCard,
  },
];

const histories: Record<string, unknown[]> = {
  'room-general': [
    {
      _id: 'general-nested-quote',
      rid: 'room-general',
      msg: `[ ](${SERVER}/channel/general?msg=quoted-card) 请处理`,
      ts: '2026-07-17T08:03:00.000Z',
      u: ALICE,
      attachments: [{
        message_link: `${SERVER}/channel/general?msg=quoted-card`,
        author_name: 'Build Bot',
        text: '',
        attachments: [{
          title: '构建失败',
          text: 'main · #128',
          fields: [{ title: '状态', value: '失败' }],
        }],
      }],
    },
    {
      _id: 'general-ocr-image',
      rid: 'room-general',
      msg: '',
      ts: '2026-07-17T08:01:00.000Z',
      u: ALICE,
      file: { _id: 'file-ocr', name: 'OCR 示例.svg', type: 'image/svg+xml', size: 256 },
      attachments: [{
        title: 'OCR 示例.svg',
        image_url: '/file-upload/ocr-thumb/demo.svg',
        image_type: 'image/png',
        title_link: '/file-upload/ocr/demo.svg',
      }],
    },
    {
      _id: 'general-release',
      rid: 'room-general',
      msg: 'Release checklist ready',
      ts: NOW,
      u: ALICE,
    },
    {
      _id: 'general-welcome',
      rid: 'room-general',
      msg: 'Welcome to General',
      ts: '2026-07-17T07:30:00.000Z',
      u: ALICE,
    },
  ],
  'room-project': [
    {
      _id: 'project-latest',
      rid: 'room-project',
      msg: 'Project plan updated',
      ts: NOW,
      u: ALICE,
    },
  ],
  'discussion-agent': [
    discussionAgentLeaseCard,
  ],
};

function scrollHistory(prefix: string, target?: { index: number; id: string; text: string }) {
  return Array.from({ length: 80 }, (_, index) => ({
    _id: target?.index === index ? target.id : `${prefix}-${index}`,
    rid: 'room-general',
    msg: target?.index === index ? target.text : `${prefix} ${index}`,
    ts: new Date(Date.parse('2026-07-17T08:00:00.000Z') + index * 1000).toISOString(),
    u: ALICE,
  }));
}

const stickerMessageFixture = {
  _id: 'general-sticker-image',
  rid: 'room-general',
  msg: '',
  ts: '2026-07-17T08:02:00.000Z',
  u: ALICE,
  file: { _id: 'file-sticker', name: '收藏示例.png', type: 'image/png', size: 128 },
  attachments: [{
    title: '收藏示例.png',
    image_url: '/file-upload/sticker/demo-thumb.png',
    title_link: '/file-upload/sticker/demo.png',
  }],
};

test('桌面 SVG 正常显示，并可用 PP-OCRv5 叠加可选择文字（issue #163、#382）', async ({ page }) => {
  await installFullTauriMock(page);
  const { pageErrors } = await bootAuthenticated(page);
  expect(await page.evaluate(() => ({
    tauri: '__TAURI_INTERNALS__' in window,
    userAgent: navigator.userAgent,
  }))).toMatchObject({ tauri: true, userAgent: expect.stringMatching(/Windows/i) });
  await conversation(page, 'General').click();
  const svg = page.getByRole('img', { name: 'OCR 示例.svg' });
  await expect(svg).toBeVisible();
  await expect.poll(() => svg.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByText('[图片加载失败：OCR 示例.svg]', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /OCR 示例\.svg/ }).last().click();
  const lightboxImage = page.getByRole('img', { name: 'OCR 示例.svg' }).last();
  await expect(lightboxImage).toBeVisible();
  await expect.poll(
    () => lightboxImage.evaluate((image) => (image as HTMLImageElement).naturalWidth),
  ).toBeGreaterThan(0);
  await expect(lightboxImage.locator('..')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await page.getByRole('button', { name: '识别图片文字' }).click();
  const layer = page.getByLabel('图片识别文字');
  await expect(layer).toBeVisible();
  const selectableWord = layer.getByText('RocketX', { exact: true });
  await expect(selectableWord).toBeVisible();
  await selectableWord.selectText();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('RocketX');
  await expect(page.getByText(/已用 PP-OCRv5 本地离线引擎\s+识别 3 处文字/)).toBeVisible();
  await expect(page.getByRole('button', { name: '复制全部识别文字' })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('桌面小尺寸 SVG 原图（24×24）在灯箱中放大显示（issue #382 第二轮）', async ({ page }) => {
  await installFullTauriMock(page);
  const { pageErrors } = await bootAuthenticated(page, {
    historyOverrides: {
      'room-general': [
        {
          _id: 'general-svg-favicon',
          rid: 'room-general',
          msg: '',
          ts: '2026-07-17T08:06:00.000Z',
          u: ALICE,
          file: { _id: 'file-svg-favicon', name: 'favicon.svg', type: 'image/svg+xml', size: 256 },
          attachments: [{
            title: 'favicon.svg',
            image_url: '/file-upload/fav-thumb/demo.svg',
            image_type: 'image/png',
            title_link: '/file-upload/fav/demo.svg',
          }],
        },
      ],
    },
  });
  await page.route('**/file-upload/fav-thumb/demo.svg', (route) => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZNE8AAAAASUVORK5CYII=',
      'base64',
    ),
  }));
  await page.route('**/file-upload/fav/demo.svg', (route) => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M22 19.2727C22 20.779 20.779 22 19.2727 22H14.7273C13.221 22 12 20.779 12 19.2727V12H19.2727C20.779 12 22 13.221 22 14.7273V19.2727Z" fill="#68C4FF"/></svg>',
  }));
  await conversation(page, 'General').click();

  const thumb = page.getByRole('img', { name: 'favicon.svg' });
  await expect(thumb).toBeVisible();
  await expect.poll(() => thumb.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

  await page.getByRole('button', { name: /favicon\.svg/ }).last().click();
  const lightboxImage = page.getByRole('img', { name: 'favicon.svg' }).last();
  await expect(lightboxImage).toBeVisible();
  await expect.poll(
    () => lightboxImage.evaluate((image) => (image as HTMLImageElement).naturalWidth),
  ).toBeGreaterThan(0);
  // 小图必须被放大到舞台尺寸（object-contain 等比），而不是按 24px 固有尺寸缩在角落
  const rendered = await lightboxImage.evaluate((image) => ({
    clientWidth: image.clientWidth,
    clientHeight: image.clientHeight,
  }));
  expect(rendered.clientWidth).toBeGreaterThan(100);
  expect(rendered.clientHeight).toBeGreaterThan(100);
  await expect(lightboxImage.locator('..')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  expect(pageErrors).toEqual([]);
});

test('桌面普通 PNG 灯箱：放大显示且不出现整幅白边（issue #386）', async ({ page }) => {
  await installFullTauriMock(page);
  const { pageErrors } = await bootAuthenticated(page, {
    historyOverrides: {
      'room-general': [
        {
          _id: 'general-png-photo',
          rid: 'room-general',
          msg: '',
          ts: '2026-07-17T08:07:00.000Z',
          u: ALICE,
          file: { _id: 'file-png-photo', name: '照片.png', type: 'image/png', size: 256 },
          attachments: [{
            title: '照片.png',
            image_url: '/file-upload/png-thumb/demo.png',
            image_type: 'image/png',
            title_link: '/file-upload/png/demo.png',
          }],
        },
      ],
    },
  });
  // 透明 PNG 的空白区域也不能被灯箱涂白。
  const onePixelPng = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 24;
    canvas.height = 24;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#68c4ff';
    context.fillRect(8, 8, 8, 8);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.route('**/file-upload/png-thumb/demo.png', (route) => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: Buffer.from(onePixelPng, 'base64'),
  }));
  await page.route('**/file-upload/png/demo.png', (route) => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: Buffer.from(onePixelPng, 'base64'),
  }));
  await conversation(page, 'General').click();

  const thumb = page.getByRole('img', { name: '照片.png' });
  await expect(thumb).toBeVisible();
  await expect.poll(() => thumb.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

  await page.getByRole('button', { name: /照片\.png/ }).last().click();
  const lightboxImage = page.getByRole('img', { name: '照片.png' }).last();
  await expect(lightboxImage).toBeVisible();
  await expect.poll(
    () => lightboxImage.evaluate((image) => (image as HTMLImageElement).naturalWidth),
  ).toBeGreaterThan(0);

  const layout = await lightboxImage.evaluate((image) => {
    const backing = image.parentElement as HTMLElement | null;
    const stage = backing?.parentElement as HTMLElement | null;
    return {
      img: { width: image.clientWidth, height: image.clientHeight },
      backing: backing ? { width: backing.clientWidth, height: backing.clientHeight } : null,
      backingBg: backing ? getComputedStyle(backing).backgroundColor : null,
      stageBg: stage ? getComputedStyle(stage).backgroundColor : null,
    };
  });
  // 小图被放大
  expect(layout.img.width).toBeGreaterThan(100);
  expect(layout.img.height).toBeGreaterThan(100);
  // 承载区域贴合图片显示框（±2px），不超出
  expect(layout.backing).not.toBeNull();
  expect(Math.abs(layout.backing!.width - layout.img.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(layout.backing!.height - layout.img.height)).toBeLessThanOrEqual(2);
  // 舞台本身不再整体白底（v0.44.5 的整幅白边回归）
  expect(layout.stageBg).not.toBe('rgb(255, 255, 255)');
  expect(layout.backingBg).toBe('rgba(0, 0, 0, 0)');
  expect(pageErrors).toEqual([]);
});

test('桌面试探说 Content-Type 但字节是 PNG 的 SVG 缩略图：按字节嗅探显示，不出现失败占位', async ({ page }) => {
  await installFullTauriMock(page);
  const { pageErrors } = await bootAuthenticated(page, {
    historyOverrides: {
      'room-general': [
        {
          _id: 'general-svg-lying-ct',
          rid: 'room-general',
          msg: '',
          ts: '2026-07-17T08:05:00.000Z',
          u: ALICE,
          file: { _id: 'file-svg-lying', name: '未命名.svg', type: 'image/svg+xml', size: 132 },
          attachments: [{
            title: '未命名.svg',
            image_url: '/file-upload/ocr-thumb-lying/demo.svg',
            image_type: 'image/svg+xml',
            title_link: '/file-upload/ocr-lying/demo.svg',
          }],
        },
      ],
    },
  });
  await page.route('**/file-upload/ocr-thumb-lying/demo.svg', (route) => route.fulfill({
    status: 200,
    // 服务端谎报：URL 与 Content-Type 都写 .svg / image/svg+xml，字节实际是 PNG
    contentType: 'image/svg+xml',
    body: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZNE8AAAAASUVORK5CYII=',
      'base64',
    ),
  }));
  await page.route('**/file-upload/ocr-lying/demo.svg', (route) => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZNE8AAAAASUVORK5CYII=',
      'base64',
    ),
  }));
  await conversation(page, 'General').click();
  const svg = page.getByRole('img', { name: '未命名.svg' });
  await expect(svg).toBeVisible();
  await expect.poll(() => svg.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByText('[图片加载失败：未命名.svg]', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /未命名\.svg/ }).last().click();
  const lightboxImage = page.getByRole('img', { name: '未命名.svg' }).last();
  await expect(lightboxImage).toBeVisible();
  await expect.poll(
    () => lightboxImage.evaluate((image) => (image as HTMLImageElement).naturalWidth),
  ).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
});

test('聊天记录中的 HTML 附件使用严格沙箱预览（issue #383）', async ({ page }) => {
  await bootAuthenticated(page, {
    historyOverrides: {
      'room-general': [
        ...histories['room-general'],
        {
          _id: 'general-html-file',
          rid: 'room-general',
          msg: '',
          ts: '2026-07-17T08:00:30.000Z',
          u: ALICE,
          file: { _id: 'preview-html', name: 'demo.html', type: 'text/html', size: 82 },
          attachments: [{
            title: 'demo.html',
            title_link: '/file-upload/preview/demo.html',
            title_link_download: true,
          }],
        },
      ],
    },
  });
  await conversation(page, 'General').click();

  await page.getByRole('button', { name: /demo\.html/ }).click();
  const htmlFrame = page.locator('iframe[title="网页预览"]');
  await expect(htmlFrame).toHaveAttribute('sandbox', '');
  await expect(htmlFrame.contentFrame().getByRole('heading', { name: 'Sandboxed HTML preview' })).toBeVisible();
});

for (const shape of ['带静态封面', '仅含 files 元数据', '仅含旧版 file 元数据']) {
  test(`聊天记录中的 MP4 视频可解码播放 · ${shape}`, async ({ page }) => {
    const file = { _id: 'preview', name: 'demo.mp4', type: 'application/octet-stream' };
    const thumbnail = { _id: 'thumbnail', name: 'cover-thumb.jpg', type: 'image/jpeg', typeGroup: 'thumb' };
    const upload = shape === '仅含 files 元数据' ? { files: [file, thumbnail] } : { file };
    if (shape === '仅含旧版 file 元数据') await installFullTauriMock(page);
    await bootAuthenticated(page, {
      historyOverrides: {
        'room-general': [{
          _id: 'video-message', rid: 'room-general', msg: '', u: ALICE, ts: NOW, ...upload,
          attachments: shape === '带静态封面' ? [{
            title: file.name, title_link: '/file-upload/preview/demo.mp4', title_link_download: true,
            image_url: '/file-upload/thumbnail/cover.jpg',
          }, { title: '视频使用说明', title_link: 'https://example.org/manual' }] : undefined,
        }],
      },
    });
    await conversation(page, 'General').click();
    if (shape === '带静态封面') {
      await expect(page.getByRole('link', { name: '视频使用说明' })).toHaveAttribute('href', 'https://example.org/manual');
    }
    await expect(page.getByRole('button', { name: /cover-thumb/ })).toHaveCount(0);
    await page.getByRole('button', { name: /demo\.mp4/ }).click({ timeout: 5_000 });
    await expectPreviewVideoToPlay(page);
  });
}

test('聊天中的旧式 HTML 文件链接可预览 GBK 网页', async ({ page }) => {
  await bootAuthenticated(page, {
    historyOverrides: { 'room-general': [{
      _id: 'old-report', rid: 'room-general', msg: '', ts: NOW, u: ALICE,
      file: { _id: 'html-gbk', name: '报表.htm', type: 'text/html' },
      attachments: [{ title: '报表.htm', title_link: '/file-upload/html-gbk/report.htm' }],
    }] },
  });
  await page.route('**/file-upload/html-gbk/report.htm', (route) => route.fulfill({
    contentType: 'application/octet-stream',
    body: Buffer.concat([
      Buffer.from('<!doctype html><meta charset=gbk><h1>'),
      Buffer.from('b2e2cad4b1a8b8e6', 'hex'), // GBK 的“测试报告”
      Buffer.from('</h1>'),
    ]),
  }));
  await conversation(page, 'General').click();
  await page.getByRole('button', { name: /报表\.htm/ }).click({ timeout: 5000 });
  const frame = page.locator('iframe[title="网页预览"]');
  await expect(frame).toHaveAttribute('sandbox', '');
  await expect(frame.contentFrame().getByRole('heading', { name: '测试报告' })).toBeVisible();
});

test('文件面板可预览超过 2 MiB 的中文 HTML 报告并保留响应字符集', async ({ page }) => {
  await bootAuthenticated(page);
  const bytes = Buffer.concat([
    Buffer.from('<!doctype html><h1>'),
    Buffer.from('b2e2cad4b1a8b8e6', 'hex'),
    Buffer.from('</h1><!--'), Buffer.alloc(2 * 1024 * 1024, 0x20), Buffer.from('-->'),
  ]);
  await page.route('**/api/v1/channels.files?**', (route) => fulfillJson(route, {
    files: [{ _id: 'large-report', name: '导出报告', type: 'text/html', size: bytes.length, url: '/file-upload/large/report' }],
  }));
  await page.route('**/file-upload/large/report', (route) => route.fulfill({
    contentType: 'text/html; charset=gb18030', body: bytes,
  }));
  await conversation(page, 'General').click();
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByText('文件', { exact: true }).click();
  await page.getByText('导出报告', { exact: true }).click();
  const frame = page.locator('iframe[title="网页预览"]');
  await expect(frame).toHaveAttribute('sandbox', '');
  await expect(frame.contentFrame().getByRole('heading', { name: '测试报告' })).toBeVisible();
});

test('聊天中的语音附件可从受保护的媒体地址播放', async ({ page }) => {
  await bootAuthenticated(page, {
    historyOverrides: {
      'room-general': [{
        _id: 'audio-message', rid: 'room-general', msg: '', u: ALICE, ts: '2026-07-17T08:00:30Z',
        attachments: [{ title: '语音留言', audio_url: '/file-upload/audio-id/voice', audio_type: 'audio/wav' }],
      }],
    },
  });
  const samples = 800;
  const wav = Buffer.alloc(44 + samples, 128);
  wav.write('RIFF'); wav.writeUInt32LE(36 + samples, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34); wav.write('data', 36); wav.writeUInt32LE(samples, 40);
  await page.route('**/file-upload/audio-id/voice', async (route) => {
    const authenticated = (await route.request().allHeaders()).cookie?.includes('rc_token=test-token');
    await route.fulfill({ status: authenticated ? 200 : 401, contentType: 'application/octet-stream', body: wav });
  });
  await conversation(page, 'General').click();
  await page.getByRole('button', { name: /语音留言/ }).click({ timeout: 5_000 });
  const player = page.locator('audio[controls]');
  await expect(player).toBeVisible();
  await expect.poll(() => player.evaluate((el: HTMLAudioElement) => el.duration)).toBeCloseTo(0.1);
});

test('房间文件面板根据服务端类型预览没有扩展名的文档', async ({ page }) => {
  await bootAuthenticated(page);
  await page.route('**/api/v1/channels.files?**', (route) => fulfillJson(route, {
    files: [{ _id: 'manual', name: '操作手册', type: 'text/markdown; charset=utf-8', url: '/file-upload/manual/readme' }],
  }));
  await page.route('**/file-upload/manual/readme', (route) => route.fulfill({
    contentType: 'application/octet-stream', body: '# 发布流程',
  }));
  await conversation(page, 'General').click();
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByText('文件', { exact: true }).click();
  await page.getByText('操作手册', { exact: true }).click();
  await expect(page.getByRole('heading', { name: '发布流程' })).toBeVisible();
});

test('预览期间显示视频读取进度，关闭或发现 HTML 超限会中止传输', async ({ page }) => {
  await bootAuthenticated(page);
  await page.route('**/api/v1/channels.files?**', (route) => fulfillJson(route, { files: [
    { _id: 'partial', name: '录屏.mp4', type: 'video/mp4', url: '/file-upload/partial/video' },
    { _id: 'oversize', name: '大型报告.html', type: 'text/html', url: '/file-upload/partial/html' },
  ] }));
  await page.evaluate(() => {
    const fetchOriginal = window.fetch;
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes('/file-upload/partial/')) return fetchOriginal(input, init);
      const isVideo = url.endsWith('/video');
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new Uint8Array(4));
        init?.signal?.addEventListener('abort', () => {
          sessionStorage.setItem(isVideo ? 'video-aborted' : 'html-aborted', 'yes');
          controller.error(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      } });
      return Promise.resolve(new Response(stream, { headers: {
        'Content-Length': isVideo ? '16' : String(13 * 1024 * 1024),
      } }));
    };
  });
  await conversation(page, 'General').click();
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByText('文件', { exact: true }).click();
  await page.getByText('录屏.mp4', { exact: true }).click();
  await expect(page.getByText('正在读取视频 25%')).toBeVisible();
  await page.getByTitle('关闭（Esc）').click();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('video-aborted'))).toBe('yes');
  await page.getByText('大型报告.html', { exact: true }).click();
  await expect(page.getByText('文件超过 12 MiB，请下载后查看')).toBeVisible();
  await expect(page.getByRole('button', { name: '直接下载' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('html-aborted'))).toBe('yes');
});

test('多附件消息按 fileId 选择对应 PDF 并渲染第一页', async ({ page }) => {
  await bootAuthenticated(page, {
    historyOverrides: {
      'room-general': [{
        _id: 'multi-doc', rid: 'room-general', msg: '', u: ALICE, ts: '2026-07-17T08:00:30Z',
        files: [{ _id: 'text', name: '附注.txt', type: 'text/plain' }, { _id: 'pdf', name: '原图说明', type: 'application/pdf' }],
        attachments: [
          { type: 'file', fileId: 'text', title_link: '/file-upload/text/note' },
          { type: 'file', fileId: 'pdf', title_link: '/file-upload/pdf/manual' },
        ],
      }],
    },
  });
  // 一页 100×100 的黑色矩形。xref 偏移按当前字节数生成，使测试可区分页面加载与实际绘制。
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  const stream = '0 0 100 100 re f\n';
  for (const body of [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ]) {
    offsets.push(pdf.length);
    pdf += `${offsets.length - 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += 'xref\n0 5\n0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await page.route('**/file-upload/pdf/manual', (route) => route.fulfill({
    contentType: 'application/octet-stream', body: pdf,
  }));
  await conversation(page, 'General').click();
  await page.getByRole('button', { name: /原图说明/ }).click();
  const canvas = page.locator('canvas[data-pdf-page="1"]');
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate((el: HTMLCanvasElement) =>
    Array.from(el.getContext('2d')!.getImageData(1, 1, 1, 1).data))).toEqual([0, 0, 0, 255]);
});

test('桌面已下载过的附件点击直接打开本地文件，文件没了才重新下载', async ({ page }) => {
  const localFile = 'C:\\Users\\tester\\Downloads\\发布包.zip';
  await installFullTauriMock(page);
  await page.addInitScript(({ server, userId, filePath }) => {
    const key = `rcx-download-history-v1:${encodeURIComponent(server.toLocaleLowerCase())}:${encodeURIComponent(userId)}`;
    localStorage.setItem(key, JSON.stringify({
      version: 1,
      records: [{
        id: 'download-zip',
        fileName: '发布包.zip',
        path: filePath,
        completedAt: Date.parse('2026-07-17T09:00:00.000Z'),
        source: { rid: 'room-general', roomName: 'General', messageId: 'general-zip-file' },
      }],
    }));
  }, { server: SERVER, userId: ME._id, filePath: localFile });
  const { pageErrors } = await bootAuthenticated(page, {
    historyOverrides: {
      'room-general': [
        ...histories['room-general'],
        {
          _id: 'general-zip-file',
          rid: 'room-general',
          msg: '',
          ts: '2026-07-17T08:00:30.000Z',
          u: ALICE,
          file: { _id: 'file-zip', name: '发布包.zip', type: 'application/zip', size: 2048 },
          attachments: [{
            title: '发布包.zip',
            title_link: '/file-upload/file-zip/release.zip',
            title_link_download: true,
          }],
        },
        {
          _id: 'general-zip-other',
          rid: 'room-general',
          msg: '',
          ts: '2026-07-17T08:00:40.000Z',
          u: ALICE,
          file: { _id: 'file-zip-other', name: '另一个包.zip', type: 'application/zip', size: 1024 },
          attachments: [{
            title: '另一个包.zip',
            title_link: '/file-upload/file-zip-other/other.zip',
            title_link_download: true,
          }],
        },
      ],
    },
  });
  const desktopCalls = () => page.evaluate(() =>
    (window as unknown as { __tauriCalls: Array<{ command: string; args?: unknown }> }).__tauriCalls
      .filter((item) => item.command === 'download_history_open' || item.command === 'plugin:dialog|save')
      .map((item) => ({ command: item.command, args: item.command === 'download_history_open' ? item.args : undefined })),
  );
  await conversation(page, 'General').click();

  const card = page.getByRole('button', { name: /发布包\.zip/ });
  await expect(card).toContainText('已下载');
  await expect(page.getByRole('button', { name: /另一个包\.zip/ })).not.toContainText('已下载');

  // 已下载：点卡片直接用系统应用打开，不弹「另存为」
  await card.click();
  await expect.poll(desktopCalls).toEqual([
    { command: 'download_history_open', args: { path: localFile } },
  ]);

  // 本地文件被删了：提示后退回正常下载流程
  await page.evaluate(() => {
    (window as unknown as { __failDownloadHistoryOpen: string }).__failDownloadHistoryOpen = '下载文件不存在或已被移动';
  });
  await page.getByRole('button', { name: '打开本地文件', exact: true }).click();
  await expect(page.getByText('本地文件已不在，重新下载')).toBeVisible();
  await expect.poll(desktopCalls).toEqual([
    { command: 'download_history_open', args: { path: localFile } },
    { command: 'download_history_open', args: { path: localFile } },
    { command: 'plugin:dialog|save', args: undefined },
  ]);

  // 「重新下载」始终可用，直接走另存为
  await expect(page.getByRole('button', { name: '重新下载', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '重新下载', exact: true }).click();
  await expect.poll(async () => (await desktopCalls()).filter((item) => item.command === 'plugin:dialog|save').length).toBe(2);
  expect(pageErrors).toEqual([]);
});

test('桌面附件留存默认关闭，可配置并按房间删除且不会重新下载（issue #152、#217）', async ({ page }) => {
  await installFullTauriMock(page);
  await page.addInitScript(({ server, userId, cachedAt }) => {
    const key = `rcx-attachment-archive-v1:${encodeURIComponent(server.toLocaleLowerCase())}:${encodeURIComponent(userId)}`;
    localStorage.setItem(key, JSON.stringify({
      version: 1,
      records: [
        {
          fileId: 'file-ocr',
          rid: 'room-general',
          roomName: 'General',
          name: 'OCR 示例.svg',
          sourcePath: '/file-upload/ocr/demo.svg',
          size: 1024,
          cachedAt,
        },
        {
          fileId: 'file-expired',
          rid: 'room-expired',
          roomName: '过期房间',
          name: '过期资料.pdf',
          sourcePath: '/file-upload/file-expired/expired.pdf',
          size: 2048,
          cachedAt: cachedAt - 40 * 86_400_000,
        },
      ],
    }));
  }, { server: SERVER, userId: ME._id, cachedAt: Date.now() });
  const { pageErrors } = await bootAuthenticated(page);

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '消息', exact: true }).last().click();
  const archiveRow = page.getByText('自动留存附件到本机', { exact: true }).locator('..').locator('..');
  const toggle = archiveRow.getByRole('switch');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByLabel('附件留存单文件上限')).toHaveValue(String(25 * 1024 * 1024));
  await expect(page.getByLabel('附件留存账号总配额')).toHaveValue(String(2 * 1024 * 1024 * 1024));
  await expect(page.getByLabel('附件留存时间')).toHaveValue('30');

  await expect(page.getByText('本地附件（1 个，1.0 KB）')).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __failArchiveRemove: boolean }).__failArchiveRemove = true;
  });
  await page.getByRole('button', { name: '删除本地副本', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '删除这个房间的本地附件' });
  await expect(dialog).toContainText('Rocket.Chat 服务器上的消息和原文件不会被删除');
  await dialog.getByRole('button', { name: '删除本地副本', exact: true }).click();
  await expect(page.getByText('mock remove failed')).toBeVisible();
  await expect(page.getByText('本地附件（1 个，1.0 KB）')).toBeVisible();

  await page.evaluate(() => {
    (window as unknown as { __failArchiveRemove: boolean }).__failArchiveRemove = false;
  });
  await page.getByRole('button', { name: '删除本地副本', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '删除这个房间的本地附件' });
  await dialog.getByRole('button', { name: '删除本地副本', exact: true }).click();
  await expect(page.getByText('本地附件（1 个，1.0 KB）')).toHaveCount(0);

  const result = await page.evaluate(({ server, userId }) => {
    const key = `rcx-attachment-archive-v1:${encodeURIComponent(server.toLocaleLowerCase())}:${encodeURIComponent(userId)}`;
    return {
      archive: JSON.parse(localStorage.getItem(key) ?? '{}'),
      removeCalls: (window as unknown as { __tauriCalls: Array<{ command: string; args?: Record<string, unknown> }> })
        .__tauriCalls.filter((item) => item.command === 'plugin:fs|remove'),
      attachmentFetchCalls: (window as unknown as {
        __tauriCalls: Array<{ command: string; args?: { clientConfig?: { url?: string } } }>;
      }).__tauriCalls.filter((item) => (
        item.command === 'plugin:http|fetch' &&
        item.args?.clientConfig?.url?.includes('/file-upload/ocr/demo.svg')
      )).length,
      thumbnailFetchCalls: (window as unknown as {
        __tauriCalls: Array<{ command: string; args?: { clientConfig?: { url?: string } } }>;
      }).__tauriCalls.filter((item) => (
        item.command === 'plugin:http|fetch' &&
        item.args?.clientConfig?.url?.includes('/file-upload/ocr-thumb/demo.svg')
      )).length,
    };
  }, { server: SERVER, userId: ME._id });
  expect(result.archive.records).toEqual([]);
  /**
   * 两条墓碑，来源不同但目的一样——都是「别再自动下回来」：
   * room-general 是用户手动点了「删除本地副本」；
   * room-expired 的 cachedAt 是 40 天前，超过默认 30 天留存期，被清理带走。
   * 过期这条早先不留痕，于是下次打开房间又被当成没下过拉回来（issue #217）。
   */
  expect(result.archive.suppressed).toEqual(expect.arrayContaining([
    expect.objectContaining({ rid: 'room-general', fileId: 'file-ocr' }),
    expect.objectContaining({ rid: 'room-expired', fileId: 'file-expired' }),
  ]));
  expect(result.archive.suppressed).toHaveLength(2);
  const recursiveRemoveCalls = result.removeCalls.filter((call) => (
    (call.args?.options as { recursive?: boolean } | undefined)?.recursive === true
  ));
  expect(recursiveRemoveCalls).toHaveLength(2);

  await page.getByRole('navigation').getByRole('button', { name: /^消息/ }).click();
  await conversation(page, 'General').click();
  await expect.poll(() => page.evaluate(({ server, userId }) => {
    const key = `rcx-attachment-archive-v1:${encodeURIComponent(server.toLocaleLowerCase())}:${encodeURIComponent(userId)}`;
    const archive = JSON.parse(localStorage.getItem(key) ?? '{"records":[]}');
    return archive.records.map((item: { fileId: string }) => item.fileId);
  }, { server: SERVER, userId: ME._id })).not.toContain('file-ocr');
  const writeCalls = await page.evaluate(() =>
    (window as unknown as { __tauriCalls: Array<{ command: string }> }).__tauriCalls
      .filter((item) => item.command === 'plugin:fs|write'),
  );
  const attachmentFetchCalls = await page.evaluate(() =>
    (window as unknown as {
      __tauriCalls: Array<{ command: string; args?: { clientConfig?: { url?: string } } }>;
    }).__tauriCalls.filter((item) => (
      item.command === 'plugin:http|fetch' &&
      item.args?.clientConfig?.url?.includes('/file-upload/ocr/demo.svg')
    )).length,
  );
  const thumbnailFetchCalls = await page.evaluate(() =>
    (window as unknown as {
      __tauriCalls: Array<{ command: string; args?: { clientConfig?: { url?: string } } }>;
    }).__tauriCalls.filter((item) => (
      item.command === 'plugin:http|fetch' &&
      item.args?.clientConfig?.url?.includes('/file-upload/ocr-thumb/demo.svg')
    )).length,
  );
  // 打开会话只读取一次 PNG 缩略图；自动留存不能重新请求 SVG 原图。
  expect(thumbnailFetchCalls).toBe(result.thumbnailFetchCalls + 1);
  expect(attachmentFetchCalls).toBe(result.attachmentFetchCalls);
  expect(writeCalls).toHaveLength(0);
  expect(pageErrors).toEqual([]);
});

test('禅模式默认关闭并可显式开启通知聚合（issue #208）', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '通知', exact: true }).click();

  const row = page.getByText('禅模式', { exact: true }).locator('..').locator('..');
  const toggle = row.getByRole('switch');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(pageErrors).toEqual([]);
});

test('桌面界面缩放恢复本机偏好，并支持固定档位与快捷键（issue #135）', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await installFullTauriMock(page);
  await page.addInitScript(() => {
    localStorage.setItem('rcx-ui-prefs', JSON.stringify({ uiScale: 125 }));
  });
  const { pageErrors } = await bootAuthenticated(page, { expectMessages: false });

  const zoomValues = () => page.evaluate(() => (
    window as unknown as {
      __tauriCalls: Array<{ command: string; args?: { value?: number } }>;
    }
  ).__tauriCalls
    .filter((call) => call.command === 'plugin:webview|set_webview_zoom')
    .map((call) => call.args?.value));

  await expect.poll(zoomValues).toContain(1.25);

  const zoomOutCancelled = await page.evaluate(() => !document.dispatchEvent(new KeyboardEvent('keydown', {
    key: '-',
    code: 'Minus',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  })));
  expect(zoomOutCancelled).toBe(true);
  await expect.poll(zoomValues).toContain(1.1);
  await expect.poll(() => page.evaluate(() => JSON.parse(
    localStorage.getItem('rcx-ui-prefs') ?? '{}',
  ).uiScale)).toBe(110);

  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', {
    key: '0',
    code: 'Digit0',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  })));
  await expect.poll(zoomValues).toContain(1);

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '桌面端', exact: true }).click();
  const scale150 = page.getByRole('radio', { name: '150%', exact: true });
  await scale150.click();
  await expect.poll(zoomValues).toContain(1.5);
  await expect(scale150).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('radio', { name: '100%', exact: true })).toHaveAttribute('aria-checked', 'false');
  await expect.poll(() => page.evaluate(() => JSON.parse(
    localStorage.getItem('rcx-ui-prefs') ?? '{}',
  ).uiScale)).toBe(150);
  await page.screenshot({ path: testInfo.outputPath('desktop-ui-scale-1080p.png'), fullPage: true });

  await page.evaluate(() => {
    (window as unknown as { __failUiScale?: boolean }).__failUiScale = true;
  });
  await page.getByRole('radio', { name: '125%', exact: true }).click();
  await expect(page.getByText('mock zoom failed', { exact: true })).toBeVisible();
  await expect(scale150).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => JSON.parse(
    localStorage.getItem('rcx-ui-prefs') ?? '{}',
  ).uiScale)).toBe(150);

  const callsBeforeRetry = (await zoomValues()).length;
  await page.evaluate(() => {
    (window as unknown as { __failUiScale?: boolean }).__failUiScale = false;
  });
  await scale150.click();
  await expect.poll(async () => (await zoomValues()).length).toBeGreaterThan(callsBeforeRetry);
  await expect(page.getByText('界面缩放已设为 150%', { exact: true }).last()).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('Web 保留浏览器原生缩放，不显示也不拦截桌面缩放入口（issue #135）', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);

  const cancelled = await page.evaluate(() => !document.dispatchEvent(new KeyboardEvent('keydown', {
    key: '+',
    code: 'Equal',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  })));
  expect(cancelled).toBe(false);

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '桌面端', exact: true }).click();
  await expect(page.getByText('界面缩放', { exact: true })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('头像卡片可编辑本人资料，切换离开后立即显示状态（issue #271）', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  const navigation = page.getByRole('navigation');

  await navigation.getByRole('button', { name: /Test User/ }).click();
  const card = page.getByRole('dialog', { name: 'Test User的个人信息' });
  await card.getByRole('button', { name: '编辑资料与状态' }).click();

  await expect(page.getByRole('heading', { name: '账号与状态' })).toBeVisible();
  await page.getByRole('button', { name: '离开', exact: true }).click();
  await expect(navigation.getByTitle('离开')).toBeVisible();

  await navigation.getByRole('button', { name: /Test User/ }).click();
  await expect(page.getByRole('dialog', { name: 'Test User的个人信息' })).toContainText('离开');
  expect(pageErrors).toEqual([]);
});

function fulfillJson(route: Route, json: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', json });
}

async function installAdoDirectMock(
  page: Page,
  workItem: {
    id: number;
    title: string;
    type: string;
    state: string;
    priority: number;
    project: string;
    assignedTo: string;
  },
) {
  const rawWorkItem = {
    id: workItem.id,
    fields: {
      'System.Title': workItem.title,
      'System.WorkItemType': workItem.type,
      'System.State': workItem.state,
      'System.TeamProject': workItem.project,
      'System.AssignedTo': { displayName: workItem.assignedTo },
      'Microsoft.VSTS.Common.Priority': workItem.priority,
    },
  };
  await page.route('**/ado/**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith('/_apis/connectionData')) {
      return fulfillJson(route, {
        authenticatedUser: {
          id: 'ado-user',
          customDisplayName: 'Test User',
          properties: { Account: { $value: 'tester' } },
        },
      });
    }
    if (/\/_apis\/wit\/wiql(?:\/[^/]+)?$/.test(url.pathname)) {
      return fulfillJson(route, { workItems: [{ id: workItem.id }] });
    }
    if (url.pathname.endsWith('/_apis/wit/workitems')) {
      return fulfillJson(route, { value: [rawWorkItem] });
    }
    if (url.pathname.endsWith(`/_apis/wit/workitems/${workItem.id}`)) {
      return fulfillJson(route, rawWorkItem);
    }
    if (url.pathname.endsWith('/_apis/projects')) {
      return fulfillJson(route, { value: [] });
    }
    return fulfillJson(route, { value: [] });
  });
}

async function installContributionAdoMock(page: Page) {
  await page.route('**/ado/**', (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.toLowerCase();
    if (path.endsWith('/_apis/connectiondata')) {
      return fulfillJson(route, {
        authenticatedUser: {
          id: 'ado-user',
          customDisplayName: 'Test User',
          properties: { Account: { $value: 'tester' } },
        },
      });
    }
    if (path.endsWith('/_apis/projects')) {
      return fulfillJson(route, { value: [{ id: 'project-alpha', name: 'Alpha' }] });
    }
    if (path.endsWith('/_apis/git/pullrequests')) {
      return fulfillJson(route, {
        value: [{
          pullRequestId: 101,
          title: 'Improve contribution profile',
          creationDate: '2026-08-10T03:00:00Z',
          createdBy: { id: 'ado-user', displayName: 'Test User' },
          repository: { id: 'repo-a', name: 'RocketX', project: { id: 'project-alpha', name: 'Alpha' } },
        }],
      });
    }
    return fulfillJson(route, { value: [] });
  });
}

async function installRocketChatMock(
  page: Page,
  options: {
    includeStickerFixture?: boolean;
    historyOverrides?: Record<string, unknown[]>;
  } = {},
) {
  const mockedHistories = { ...histories, ...options.historyOverrides };
  let ownStatus = ME.status;
  const sentMessages: Record<string, unknown>[] = [];
  const uploadedMessages: Record<string, unknown>[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.route('**/avatar/**', (route) => route.fulfill({ status: 204 }));
  await page.route('**/file-upload/ocr/demo.svg', (route) => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="240"><path fill="#000" d="M40 40h520v160H40z"/></svg>',
  }));
  await page.route('**/file-upload/ocr-thumb/demo.svg', (route) => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZNE8AAAAASUVORK5CYII=',
      'base64',
    ),
  }));
  await page.route('**/file-upload/sticker/demo-thumb.png', (route) => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  }));
  await page.route('**/file-upload/sticker/demo.png', (route) => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04]),
  }));
  await page.route('**/file-upload/preview/demo.html', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><body><h1>Sandboxed HTML preview</h1></body></html>',
  }));
  await page.route('**/file-upload/preview/readme.md', (route) => route.fulfill({
    status: 200,
    contentType: 'text/markdown',
    body: '# RocketX 文档\n\n> 统一 Markdown 预览。\n\n| 入口 | 状态 |\n| --- | --- |\n| 文件 | 正常 |\n\n```sh\npnpm test\n```',
  }));
  await page.route('**/file-upload/preview/demo.mp4', async (route) => {
    const headers = await route.request().allHeaders();
    const authenticated = headers.cookie?.includes('rc_token=test-token') || headers['x-auth-token'] === 'test-token';
    await route.fulfill({ status: authenticated ? 200 : 401, contentType: 'application/octet-stream', body: PREVIEW_VIDEO });
  });
  await page.route('**/api/info', (route) => fulfillJson(route, { version: '8.6.1' }));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const endpoint = url.pathname.split('/api/v1/')[1] ?? '';

    if (endpoint === 'login') {
      return fulfillJson(route, {
        status: 'success',
        data: { authToken: 'test-token', userId: ME._id, me: { ...ME, status: ownStatus } },
      });
    }
    if (endpoint === 'settings.public') {
      const id = url.searchParams.get('_id');
      return fulfillJson(route, {
        settings: [{ _id: id, value: id === 'Site_Url' ? SERVER : false }],
      });
    }
    if (endpoint === 'subscriptions.get') return fulfillJson(route, { update: subscriptions });
    if (endpoint === 'rooms.get') return fulfillJson(route, { update: rooms });
    if (endpoint === 'commands.list') return fulfillJson(route, { commands: [] });
    if (endpoint === 'me') {
      return fulfillJson(route, { ...ME, status: ownStatus, settings: { preferences: {} } });
    }
    if (endpoint === 'users.info') {
      const user = url.searchParams.get('userId') === ALICE._id ? ALICE : ME;
      return fulfillJson(route, { user: { ...user, status: ownStatus, settings: { preferences: {} } } });
    }
    if (endpoint === 'users.presence') {
      return fulfillJson(route, { users: [{ ...ME, status: ownStatus }, ALICE] });
    }
    if (endpoint === 'users.setStatus') {
      ownStatus = String((request.postDataJSON() as { status?: string }).status ?? ownStatus);
      return fulfillJson(route, { success: true });
    }
    if (endpoint === 'channels.members') {
      return fulfillJson(route, { members: [ME, ALICE], total: 2 });
    }
    if (endpoint === 'channels.files') {
      return fulfillJson(route, {
        files: [
          { _id: 'preview-html', name: 'demo.html', type: 'text/html', url: '/file-upload/preview/demo.html', size: 82 },
          { _id: 'preview-markdown', name: 'readme.md', type: 'text/markdown', url: '/file-upload/preview/readme.md', size: 128 },
          { _id: 'preview-video', name: 'demo.mp4', type: 'video/mp4', url: '/file-upload/preview/demo.mp4', size: PREVIEW_VIDEO.length },
        ],
      });
    }
    if (endpoint === 'channels.history' || endpoint === 'groups.history') {
      const rid = url.searchParams.get('roomId') ?? '';
      const history = mockedHistories[rid] ?? [];
      const messages = rid === 'discussion-agent'
        ? history.map((message) => {
          const referenceAt = Date.now();
          return message._id === 'agent-lease-card'
            ? { ...message, msg: agentCardMessage(referenceAt), ts: new Date(referenceAt).toISOString() }
            : message;
        })
        : history;
      return fulfillJson(route, {
        messages: options.includeStickerFixture && rid === 'room-general'
          ? [...messages, stickerMessageFixture]
          : messages,
      });
    }
    if (endpoint === 'chat.sendMessage') {
      const body = request.postDataJSON() as { message: Record<string, unknown> };
      sentMessages.push(body.message);
      return fulfillJson(route, {
        message: { ...body.message, ts: new Date().toISOString(), u: ME },
      });
    }
    if (endpoint.startsWith('rooms.media/')) {
      return fulfillJson(route, { file: { _id: `file-${uploadedMessages.length + 1}` } });
    }
    if (endpoint.startsWith('rooms.mediaConfirm/')) {
      uploadedMessages.push(request.postDataJSON() as Record<string, unknown>);
      return fulfillJson(route, { success: true });
    }
    if (endpoint === 'rooms.createDiscussion') {
      return fulfillJson(route, {
        discussion: {
          _id: 'discussion-128',
          t: 'p',
          prid: 'room-general',
          name: '128-login-failure',
          fname: '#128 Login failure',
          usersCount: 1,
        },
      });
    }
    if (endpoint === 'chat.getMessage') {
      const mid = url.searchParams.get('msgId');
      const message = Object.values(mockedHistories)
        .flat()
        .find((item) => item._id === mid);
      return message
        ? fulfillJson(route, { message })
        : fulfillJson(route, { message: null }, 404);
    }
    if (endpoint === 'chat.getThreadMessages') {
      const tmid = url.searchParams.get('tmid');
      const messages = Object.values(mockedHistories)
        .flat()
        .filter((item) => item._id === tmid || item.tmid === tmid);
      return fulfillJson(route, { messages });
    }
    if (endpoint.endsWith('.roles')) {
      const rid = url.searchParams.get('roomId');
      return fulfillJson(route, {
        roles: rid === 'discussion-agent'
          ? [{
            _id: 'role-discussion-agent-alice',
            rid,
            u: ALICE,
            roles: ['moderator'],
          }]
          : [],
      });
    }
    return fulfillJson(route, { success: true });
  });

  await page.routeWebSocket('**/websocket', (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as {
        msg?: string; id?: string; method?: string; params?: [{ rid: string; _id: string }];
      };
      if (message.msg === 'connect') socket.send(JSON.stringify({ msg: 'connected', session: 'ui-smoke' }));
      if (message.msg === 'method' && message.id) {
        if (message.method === 'loadSurroundingMessages') {
          const target = message.params![0];
          const history = mockedHistories[target.rid] ?? [];
          const index = history.findIndex((entry) => entry._id === target._id);
          const result = index < 0 ? false : { messages: history.slice(Math.max(0, index - 24), index + 26) };
          socket.send(JSON.stringify({ msg: 'result', id: message.id, result }));
          return;
        }
        socket.send(JSON.stringify({ msg: 'result', id: message.id, result: {} }));
      }
    });
  });

  return { sentMessages, uploadedMessages, pageErrors };
}

async function bootAuthenticated(
  page: Page,
  options: {
    expectMessages?: boolean;
    includeStickerFixture?: boolean;
    historyOverrides?: Record<string, unknown[]>;
  } = {},
) {
  const state = await installRocketChatMock(page, options);
  await page.addInitScript(({ server, userId }) => {
    localStorage.setItem('rcx-server', server);
    localStorage.setItem('rcx-auth', JSON.stringify({ authToken: 'test-token', userId }));
    localStorage.setItem('rcx-owner', `${userId}@${server}`);
    localStorage.setItem(
      `rcx-onboarding-v1:${encodeURIComponent(server)}:${userId}`,
      JSON.stringify({
        version: 1,
        ado: 'skipped',
        checklist: {
          startedConversation: true,
          sentMessage: true,
          notificationsEnabled: true,
          dismissed: true,
        },
      }),
    );
  }, {
    server: SERVER,
    userId: ME._id,
  });
  await page.goto('/');
  if (options.expectMessages !== false) {
    await expect(page.getByText('General', { exact: true }).first()).toBeVisible();
  }
  return state;
}

async function activateAiRuntimeForTest(
  page: Page,
  provider: 'pi' | 'none',
): Promise<void> {
  await page.waitForFunction(async () => {
    const { useUI } = await import('/src/stores/ui.ts');
    return useUI.getState().startupStage === 'background-ready';
  });
  await page.evaluate(async (nextProvider) => {
    const [{ activateAiRuntimeProvider }, { useUI }] = await Promise.all([
      import('/src/lib/runtimeMode.ts'),
      import('/src/stores/ui.ts'),
    ]);
    activateAiRuntimeProvider(nextProvider);
    useUI.setState({ aiRuntimeProvider: nextProvider });
  }, provider);
}

function conversation(page: Page, name: string) {
  return page.locator('button[title*="右键更多操作"]').filter({ hasText: name });
}

test('登录后进入主界面', async ({ page }) => {
  const { pageErrors } = await installRocketChatMock(page);
  await page.goto('/');
  await page.getByRole('button', { name: '连接 Rocket.Chat', exact: true }).click();
  await expect(page.getByText('RocketChat X', { exact: true })).toBeVisible();
  await page.getByPlaceholder('留空使用当前站点').fill(SERVER);
  await page.getByPlaceholder('请输入用户名或邮箱').fill('tester');
  await page.getByPlaceholder('请输入密码').fill('password');
  await page.getByRole('button', { name: '连接并登录 Rocket.Chat', exact: true }).click();
  await expect(page.getByRole('heading', { name: '连接 Azure DevOps' })).toHaveCount(0);
  await expect(page.getByText('General', { exact: true }).first()).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('登录页同时显示友好结论和脱敏后的详细连接原因', async ({ page }) => {
  const { pageErrors } = await installRocketChatMock(page);
  await page.unroute('**/api/info');
  await page.route('**/api/info', (route) => fulfillJson(route, { error: 'gateway unavailable' }, 502));

  await page.goto('/');
  await page.getByRole('button', { name: '连接 Rocket.Chat', exact: true }).click();
  await page.getByPlaceholder('留空使用当前站点').fill(SERVER);
  await page.getByPlaceholder('请输入用户名或邮箱').fill('tester');
  await page.getByPlaceholder('请输入密码').fill('password');
  await page.getByRole('button', { name: '连接并登录 Rocket.Chat', exact: true }).click();

  await expect(page.getByText('服务器检查失败，请稍后重试')).toBeVisible();
  await expect(page.getByText('服务器返回 HTTP 502：HTTP 502')).toBeVisible();
  await expect(page.getByText('General', { exact: true })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('登录接口返回 unreadable 时改为可操作的中文原因', async ({ page }) => {
  const { pageErrors } = await installRocketChatMock(page);
  await page.unroute('**/api/v1/**');
  await page.route('**/api/v1/login', (route) => fulfillJson(route, { error: 'unreadable' }, 500));

  await page.goto('/');
  await page.getByRole('button', { name: '连接 Rocket.Chat', exact: true }).click();
  await page.getByPlaceholder('留空使用当前站点').fill(SERVER);
  await page.getByPlaceholder('请输入用户名或邮箱').fill('tester');
  await page.getByPlaceholder('请输入密码').fill('password');
  await page.getByRole('button', { name: '连接并登录 Rocket.Chat', exact: true }).click();

  await expect(page.getByText('登录请求没有成功发出，请检查地址、网络、VPN 或桌面端访问权限')).toBeVisible();
  await expect(page.getByText(/桌面网络通道没有读取到可用响应/)).toBeVisible();
  await expect(page.getByText(/unreadable/i)).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('文件面板在严格沙箱中预览 HTML，并为常见视频显示原生控件（issue #318）', async ({ page }) => {
  await bootAuthenticated(page);
  await conversation(page, 'General').click();
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByText('文件', { exact: true }).click();

  await page.getByText('demo.html', { exact: true }).click();
  const htmlFrame = page.locator('iframe[title="网页预览"]');
  await expect(htmlFrame).toHaveAttribute('sandbox', '');
  await expect(htmlFrame.contentFrame().getByRole('heading', { name: 'Sandboxed HTML preview' })).toBeVisible();
  await page.getByTitle('关闭（Esc）').click();

  await page.getByText('demo.mp4', { exact: true }).click();
  await expectPreviewVideoToPlay(page);
});

test('Markdown 文件预览使用完整文档排版（issue #319）', async ({ page }, testInfo) => {
  const { pageErrors } = await bootAuthenticated(page);
  await conversation(page, 'General').click();
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByText('文件', { exact: true }).click();

  await page.getByText('readme.md', { exact: true }).click();
  const markdown = page.locator('.rocketx-markdown--doc');
  await expect(markdown).toHaveAttribute('data-variant', 'doc');
  await expect(markdown.getByRole('heading', { name: 'RocketX 文档', level: 1 })).toBeVisible();
  await expect(markdown.locator('blockquote')).toContainText('统一 Markdown 预览');
  await expect(markdown.locator('table')).toContainText('文件');
  await expect(markdown.locator('pre')).toContainText('pnpm test');
  const docLayout = await markdown.evaluate((element) => {
    const heading = element.querySelector('h1');
    const paragraph = element.querySelector('p');
    const codeBlock = element.querySelector('pre');
    const containerRect = element.getBoundingClientRect();
    const paragraphRect = paragraph?.getBoundingClientRect();
    const codeRect = codeBlock?.getBoundingClientRect();
    return {
      headingFontSize: heading ? Number.parseFloat(getComputedStyle(heading).fontSize) : 0,
      paragraphWidth: paragraphRect?.width ?? 0,
      containerWidth: containerRect.width,
      codeWidth: codeRect?.width ?? 0,
    };
  });
  expect(docLayout.headingFontSize).toBeLessThanOrEqual(24);
  expect(docLayout.paragraphWidth).toBeGreaterThan(480);
  expect(docLayout.paragraphWidth).toBeLessThan(docLayout.containerWidth * 0.82);
  expect(docLayout.codeWidth).toBeGreaterThan(docLayout.paragraphWidth);
  await markdown.screenshot({ path: testInfo.outputPath('markdown-file-preview-319.png') });
  await page.getByTitle('关闭（Esc）').click();
  expect(pageErrors).toEqual([]);
});

async function openLocalDesktopSetup(page: Page, narrow = false) {
  await page.goto('/');
  await expect(page.locator('.butler-workspace')).toBeVisible();
  await expect(page.getByPlaceholder('请输入用户名或邮箱')).toHaveCount(0);
  if (narrow) {
    await page.getByRole('button', { name: '打开任务列表' }).click();
    await page.getByRole('dialog', { name: '任务列表' }).getByRole('button', { name: '返回 RocketX' }).click();
  } else {
    await page.getByRole('navigation', { name: 'RocketX 主导航' }).getByRole('button', { name: '连接 Rocket.Chat' }).click();
  }
}

test('深色主题首次引导的说明面板保持高对比度（issue #305）', { tag: '@release-desktop' }, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installTauriMock(page);
  await page.addInitScript(() => localStorage.setItem('rcx-theme', 'dark'));

  const contrastOf = async (locator: Locator): Promise<number> => {
    await expect(locator).toBeVisible();
    return locator.evaluate((element) => {
      const panel = element.closest('section');
      if (!panel) return 0;
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return 0;
      const parseColor = (value: string): { rgb: number[]; alpha: number } => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = value;
        context.fillRect(0, 0, 1, 1);
        const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
        return { rgb: [red, green, blue], alpha: alpha / 255 };
      };
      const composite = (
        foreground: { rgb: number[]; alpha: number },
        background: { rgb: number[]; alpha: number },
      ): { rgb: number[]; alpha: number } => {
        const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha);
        return {
          rgb: foreground.rgb.map((channel, index) => (
            channel * foreground.alpha
              + (background.rgb[index] ?? 0) * background.alpha * (1 - foreground.alpha)
          ) / alpha),
          alpha,
        };
      };
      const layers: Element[] = [];
      for (let current: Element | null = element; current; current = current.parentElement) {
        layers.push(current);
        if (current === panel) break;
      }
      const background = layers.reverse().reduce(
        (result, layer) => composite(parseColor(getComputedStyle(layer).backgroundColor), result),
        { rgb: [0, 0, 0], alpha: 0 },
      );
      const foreground = composite(parseColor(getComputedStyle(element).color), background);
      const luminance = ([red = 0, green = 0, blue = 0]: number[]): number => {
        const linear = [red, green, blue].map((channel) => {
          const normalized = channel / 255;
          return normalized <= 0.04045
            ? normalized / 12.92
            : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
      };
      const foregroundLuminance = luminance(foreground.rgb);
      const backgroundLuminance = luminance(background.rgb);
      return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
        / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
    });
  };

  await openLocalDesktopSetup(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await contrastOf(page.getByRole('heading', { name: 'GTD 是运行方式，注意力是检验标准。' }))).toBeGreaterThanOrEqual(7);
  expect(await contrastOf(page.getByText('你直接掌握的确定性界面。', { exact: true }))).toBeGreaterThanOrEqual(4.5);

  await page.getByRole('button', {
    name: RELEASE_DESKTOP_E2E ? '继续：设置桌面体验' : '继续：选择如何加入',
  }).click();
  if (RELEASE_DESKTOP_E2E) {
    expect(await contrastOf(page.getByRole('heading', { name: /第一次启动时.*把该交给系统的事交给系统/ }))).toBeGreaterThanOrEqual(7);
    expect(await contrastOf(page.getByText(/这一步只决定是否向操作系统申请通知权限/))).toBeGreaterThanOrEqual(4.5);
    await page.getByRole('button', { name: '应用并继续' }).click();
    await page.getByRole('button', { name: '继续加入团队' }).click();
  }
  expect(await contrastOf(page.getByRole('heading', { name: /消息用来沟通.*工作台用来确定.*管家用来完成/ }))).toBeGreaterThanOrEqual(7);
  expect(await contrastOf(page.getByText('团队讨论、上下文和原始事实留在这里。', { exact: true }))).toBeGreaterThanOrEqual(4.5);
});

test('桌面新安装可直接使用本地管家，连接消息时提供理念与团队设置', { tag: '@release-desktop' }, async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await installTauriMock(page);

  await openLocalDesktopSetup(page);
  await expect(page.getByRole('heading', { name: /把大脑从“记住所有事”里解放出来，\s*把注意力留给正在做的事。/ })).toBeVisible();
  await expect(page.getByText('先可靠地收住', { exact: true })).toBeVisible();
  await expect(page.getByText('让下一步清楚', { exact: true })).toBeVisible();
  await expect(page.getByText('保护稀缺注意力', { exact: true })).toBeVisible();
  await expect(page.getByText('工作台 · 事实与计划', { exact: true })).toBeVisible();
  await expect(page.getByText('管家 · 判断与执行', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '加入团队工作区' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('gtd-attention-onboarding.png'), fullPage: true });

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);

  await page.getByRole('button', {
    name: RELEASE_DESKTOP_E2E ? '继续：设置桌面体验' : '继续：选择如何加入',
  }).click();
  if (RELEASE_DESKTOP_E2E) {
    await expect(page.getByRole('heading', { name: '桌面默认设置' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /允许系统通知/ })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: /登录系统后启动 RocketX/ })).toBeChecked();
    await page.screenshot({ path: testInfo.outputPath('desktop-defaults.png'), fullPage: true });
    await page.getByRole('button', { name: '应用并继续' }).click();
    await expect(page.getByText('已开启', { exact: true })).toHaveCount(2);
    await expect.poll(() => page.evaluate(() => JSON.parse(
      localStorage.getItem('rcx-desktop-defaults-v1') ?? '{}',
    ))).toEqual({
      version: 1,
      status: 'applied',
      notifications: 'enabled',
      autostart: 'enabled',
    });
    await page.getByRole('button', { name: '继续加入团队' }).click();
  }
  await expect(page.getByRole('heading', { name: '加入团队工作区' })).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles({
    name: 'rcx.workspace.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      version: 1,
      name: '验证团队',
      rocketChat: { url: 'https://chat.example.com' },
      ado: { url: 'https://ado.example.com/tfs/DefaultCollection', mode: 'direct', auth: 'pat' },
      workItemTemplates: {
        defaultProject: 'Alpha',
        templates: [{ name: '单个工作项', items: [{ type: '{type}', title: '{title}' }] }],
      },
    })),
  });
  await expect(page.getByRole('heading', { name: '加入「验证团队」' })).toBeVisible();
  await expect(page.getByText('1 个内联模板', { exact: true })).toBeVisible();
  await expect(page.getByText('用户名、密码、PAT 和 AI 密钥不会从团队配置读取')).toBeVisible();
  await page.getByRole('button', { name: '确认并继续' }).click();
  await expect(page.getByText('验证团队', { exact: true })).toBeVisible();
  await expect(page.getByText('https://chat.example.com', { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder('https://chat.example.com')).toHaveCount(0);
  await expect(page.getByPlaceholder('请输入用户名或邮箱')).toBeVisible();
  await expect(page.getByPlaceholder('请输入密码')).toBeVisible();
  expect(await page.evaluate(() => ({
    url: localStorage.getItem('rcx-wi-template-url'),
    config: JSON.parse(localStorage.getItem('rcx-wi-template-cache') ?? '{}'),
  }))).toEqual({
    url: null,
    config: {
      defaultProject: 'Alpha',
      templates: [{ name: '单个工作项', items: [{ type: '{type}', title: '{title}' }] }],
    },
  });
  expect(pageErrors).toEqual([]);
});

test('首次引导在 390px 下保持单列且关键操作可达', { tag: '@release-desktop' }, async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await installTauriMock(page);

  await openLocalDesktopSetup(page, true);
  await expect(page.getByRole('heading', { name: /把大脑从“记住所有事”里解放出来/ })).toBeVisible();
  const expectedContinue = RELEASE_DESKTOP_E2E ? '继续：设置桌面体验' : '继续：选择如何加入';
  await expect(page.getByRole('button', { name: expectedContinue })).toBeVisible();
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  )).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('gtd-attention-onboarding-mobile.png'), fullPage: true });

  const continueButton = page.getByRole('button', { name: expectedContinue });
  await continueButton.scrollIntoViewIfNeeded();
  await expect(continueButton).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('gtd-attention-onboarding-mobile-action.png') });
  await continueButton.click();
  if (RELEASE_DESKTOP_E2E) {
    await expect(page.getByRole('heading', { name: '桌面默认设置' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await expect.poll(() => page.locator('#root').evaluate((element) => element.scrollTop)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('desktop-defaults-mobile.png'), fullPage: true });
    await page.getByRole('button', { name: '应用并继续' }).click();
    await expect(page.getByText('已开启', { exact: true })).toHaveCount(2);
    await page.getByRole('button', { name: '继续加入团队' }).click();
  }
  await expect(page.getByRole('heading', { name: '加入团队工作区' })).toBeVisible();
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  )).toBe(false);
  expect(pageErrors).toEqual([]);
});

test('桌面重启后会重新授权并检查团队配置 URL', { tag: '@release-desktop' }, async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await installTauriMock(page, {
    version: 1,
    name: '同步团队',
    rocketChat: { url: 'https://chat.example.com' },
    update: { source: 'dir', location: '\\\\fileserver\\software\\rocketx' },
  });
  await page.addInitScript(() => {
    localStorage.setItem('rcx-server', 'https://chat.example.com');
    localStorage.setItem('rcx-update-source', JSON.stringify({ kind: 'github', location: '' }));
    localStorage.setItem('rcx-first-run-v1', 'complete');
    localStorage.setItem('rcx-workspace-source', JSON.stringify({
      url: 'https://git.example.com/team/raw/rcx.workspace.json',
      name: '同步团队',
      importedAt: 1,
      lastCheckedAt: 0,
      follow: true,
      applied: {
        'server.url': 'https://chat.example.com',
        'update.source': 'github|',
      },
    }));
  });

  await page.goto('/');
  await expect(page.getByText(/团队配置有更新：1 项变化/)).toBeVisible();
  const desktopDefaults = await page.evaluate(() => localStorage.getItem('rcx-desktop-defaults-v1'));
  if (RELEASE_DESKTOP_E2E) {
    expect(JSON.parse(desktopDefaults ?? '{}')).toEqual({
      version: 1,
      status: 'legacy-migrated',
      notifications: 'preserved',
      autostart: 'preserved',
    });
  } else {
    expect(desktopDefaults).toBeNull();
  }
  expect(pageErrors).toEqual([]);
});

test('桌面已有有效账号直接恢复消息并保留桌面权限', { tag: '@release-desktop' }, async ({ page }) => {
  await installFullTauriMock(page);
  const { pageErrors } = await bootAuthenticated(page);
  await expect(conversation(page, 'General')).toBeVisible();
  await expect(page.getByRole('heading', { name: '加入团队工作区' })).toHaveCount(0);
  const saved = await page.evaluate(() => ({
    firstRun: localStorage.getItem('rcx-first-run-v1'),
    defaults: JSON.parse(localStorage.getItem('rcx-desktop-defaults-v1') ?? 'null'),
  }));
  expect(saved.firstRun).toBeNull();
  expect(saved.defaults).toEqual(RELEASE_DESKTOP_E2E ? {
    version: 1, status: 'legacy-migrated', notifications: 'preserved', autostart: 'preserved',
  } : null);
  expect(pageErrors).toEqual([]);
});

test('桌面跳过连接后可以重启回到本地管家', { tag: '@release-desktop' }, async ({ page }) => {
  await installTauriMock(page);
  await openLocalDesktopSetup(page);
  await page.getByRole('button', { name: '暂不连接，直接本地使用' }).click();
  if (RELEASE_DESKTOP_E2E) {
    await page.getByRole('checkbox', { name: /允许系统通知/ }).uncheck();
    await page.getByRole('checkbox', { name: /登录系统后启动 RocketX/ }).uncheck();
    await page.getByRole('button', { name: '应用并继续' }).click();
    await page.getByRole('button', { name: '进入本地工作区' }).click();
  }
  await expect(page.locator('.butler-workspace')).toBeVisible();
  await page.reload();
  await expect(page.locator('.butler-workspace')).toBeVisible();
  await page.getByRole('navigation', { name: 'RocketX 主导航' }).getByRole('button', { name: '连接 Rocket.Chat' }).click();
  await expect(page.getByPlaceholder('请输入用户名或邮箱')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('rcx-first-run-v1'))).toBe('complete');
});

test('已登录账号从设置重跑引导时打开连接流程并保留系统偏好', { tag: '@release-desktop' }, async ({ page }) => {
  await installFullTauriMock(page);
  await installRocketChatMock(page);
  await page.addInitScript(({ server, userId }) => {
    if (sessionStorage.getItem('seeded-test-account')) return;
    sessionStorage.setItem('seeded-test-account', '1');
    localStorage.setItem('rcx-server', server);
    localStorage.setItem('rcx-owner', `${userId}@${server}`);
    localStorage.setItem('rcx-auth', JSON.stringify({ authToken: 'test-token', userId }));
    localStorage.setItem('rcx-first-run-v1', 'complete');
  }, { server: SERVER, userId: ME._id });
  await page.goto('/');
  await expect(conversation(page, 'General')).toBeVisible();
  await page.getByRole('navigation', { name: 'RocketX 主导航' }).getByRole('button', { name: '设置' }).click();
  await page.getByRole('button', { name: '重新运行首次设置' }).click();
  await page.getByRole('button', { name: '重新开始' }).click();
  await expect(page.getByRole('heading', { name: /把大脑从“记住所有事”里解放出来/ })).toBeVisible();
  await page.getByRole('button', { name: '继续：选择如何加入' }).click();
  await expect(page.getByRole('heading', { name: '加入团队工作区' })).toBeVisible();
  if (RELEASE_DESKTOP_E2E) {
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('rcx-desktop-defaults-v1')!))).toEqual({
      version: 1, status: 'legacy-migrated', notifications: 'preserved', autostart: 'preserved',
    });
  }
});

test('团队配置可从当前 ADO 仓库读取、预览并应用', async ({ page }, testInfo) => {
  const adoRequests: Array<{ url: string; authorization?: string }> = [];
  await page.route('https://ado.example.com/**', async (route) => {
    const request = route.request();
    adoRequests.push({
      url: request.url(),
      authorization: await request.headerValue('authorization') ?? undefined,
    });
    const url = new URL(request.url());
    if (url.pathname.includes('/_apis/git/repositories/')) {
      return fulfillJson(route, {
        content: JSON.stringify({
          version: 1,
          name: 'ADO 团队',
          update: { source: 'dir', location: '\\\\fileserver\\software\\rocketx' },
        }),
      });
    }
    return fulfillJson(route, { id: 'project-road-map', name: 'Road Map' });
  });
  await page.addInitScript(() => {
    localStorage.setItem('rcx-workbench', JSON.stringify({
      mode: 'direct',
      adoBase: 'https://ado.example.com/tfs/DefaultCollection',
      auth: 'pat',
      pat: 'workspace-pat',
      account: 'tester',
    }));
  });
  const { pageErrors } = await bootAuthenticated(page);

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '团队配置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '团队配置', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: '配置来源', exact: true, level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: '本地工作区' })).toHaveCount(0);
  await expect(page.getByText('从当前 Azure DevOps 仓库读取', { exact: true })).toBeVisible();
  await expect(page.getByText('读取前请填写：项目、仓库', { exact: true })).toBeVisible();
  await page.getByLabel('ADO 项目').fill('Road Map');
  await page.getByLabel('ADO 仓库').fill('Rocket X');
  await page.screenshot({ path: testInfo.outputPath('ado-team-config.png'), fullPage: true });
  await page.getByRole('button', { name: '从 ADO 读取', exact: true }).click();

  await expect(page.getByRole('dialog', { name: '导入「ADO 团队」' })).toBeVisible();
  const updateSource = page.getByRole('checkbox', { name: /更新源/ });
  await expect(updateSource).not.toBeChecked();
  await updateSource.check();
  await page.getByRole('button', { name: '应用 1 项', exact: true }).click();
  await expect(page.getByText('上次导入：ADO 团队')).toBeVisible();

  const stored = await page.evaluate(() => ({
    source: JSON.parse(localStorage.getItem('rcx-workspace-source') ?? '{}'),
    update: JSON.parse(localStorage.getItem('rcx-update-source') ?? '{}'),
  }));
  expect(stored.source).toMatchObject({
    kind: 'ado',
    follow: true,
    ado: {
      adoBase: 'https://ado.example.com/tfs/DefaultCollection',
      auth: 'pat',
      project: 'Road Map',
      repository: 'Rocket X',
      ref: 'refs/heads/main',
      path: '/config/rcx.workspace.json',
    },
  });
  expect(JSON.stringify(stored.source)).not.toContain('workspace-pat');
  expect(stored.update).toEqual({ kind: 'dir', location: '\\\\fileserver\\software\\rocketx' });
  expect(adoRequests).toHaveLength(2);
  expect(adoRequests.every((request) => request.authorization?.startsWith('Basic '))).toBe(true);
  expect(adoRequests[1]?.url).toContain('versionDescriptor.version=main');
  expect(adoRequests[1]?.url).toContain('versionDescriptor.versionType=branch');
  expect(pageErrors).toEqual([]);
});

test('团队 ADO 端点变化会解绑 PAT，并保持旧 AI 设置不被工作区导入接管', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('rcx-workbench', JSON.stringify({
      mode: 'direct',
      adoBase: 'https://ado-old.example.com/tfs/DefaultCollection',
      auth: 'pat',
      pat: 'old-pat',
      account: 'tester',
    }));
    localStorage.setItem('rcx-ai-settings-v1', JSON.stringify({
      providers: [{
        id: 'team-ai',
        kind: 'openai-compatible',
        name: 'Team AI',
        baseUrl: 'https://ai-old.example.com/v1',
        model: 'old-model',
        locality: 'local',
        hasSecret: true,
      }],
      routes: Object.fromEntries(
        ['summary', 'extraction', 'daily-review', 'butler-rounds', 'text-tool', 'agent']
          .map((id) => [id, { providerId: 'team-ai', localOnly: false }]),
      ),
    }));
    localStorage.setItem('rcx-workspace-source', JSON.stringify({
      url: 'https://git.example.com/team/raw/rcx.workspace.json',
      name: '旧团队',
      importedAt: 1,
      follow: true,
      applied: {
        'ado.base': 'https://ado-old.example.com/tfs/DefaultCollection',
        'ado.mode': 'direct',
        'ado.auth': 'pat',
      },
    }));
  });
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '团队配置', exact: true }).click();
  await page.locator('input[accept=".json,application/json"]').setInputFiles({
    name: 'rcx.workspace.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      version: 1,
      name: '新团队',
      ado: { url: 'https://ado-new.example.com/tfs/DefaultCollection', mode: 'direct', auth: 'pat' },
    })),
  });
  await page.getByRole('button', { name: /应用 \d+ 项/ }).click();

  const stored = await page.evaluate(() => ({
    workbench: JSON.parse(localStorage.getItem('rcx-workbench') ?? '{}'),
    ai: JSON.parse(localStorage.getItem('rcx-ai-settings-v1') ?? '{}'),
    source: JSON.parse(localStorage.getItem('rcx-workspace-source') ?? '{}'),
  }));
  expect(stored.workbench).not.toHaveProperty('pat');
  expect(stored.workbench.adoBase).toBe('https://ado-new.example.com/tfs/DefaultCollection');
  expect(stored.ai.providers[0]).toMatchObject({
    id: 'team-ai',
    baseUrl: 'https://ai-old.example.com/v1',
    locality: 'local',
    hasSecret: true,
  });
  expect(stored.source).not.toHaveProperty('url');
  expect(stored.source).not.toHaveProperty('follow');
  expect(pageErrors).toEqual([]);
});

test('团队 Rocket.Chat 地址变化会清理旧会话并要求重新登录', async ({ page }) => {
  const { pageErrors } = await installRocketChatMock(page);
  await page.addInitScript(({ server, userId }) => {
    if (sessionStorage.getItem('rcx-server-change-seeded')) return;
    sessionStorage.setItem('rcx-server-change-seeded', '1');
    localStorage.setItem('rcx-server', server);
    localStorage.setItem('rcx-auth', JSON.stringify({ authToken: 'test-token', userId }));
    localStorage.setItem('rcx-owner', `${userId}@${server}`);
    localStorage.setItem(
      `rcx-onboarding-v1:${encodeURIComponent(server)}:${userId}`,
      JSON.stringify({
        version: 1,
        ado: 'skipped',
        checklist: {
          startedConversation: true,
          sentMessage: true,
          notificationsEnabled: true,
          dismissed: true,
        },
      }),
    );
    localStorage.setItem('rcx-workspace-source', JSON.stringify({
      name: '旧团队',
      importedAt: 1,
      applied: { 'server.url': server },
    }));
  }, { server: SERVER, userId: ME._id });

  await page.goto('/');
  await expect(page.getByText('General', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '团队配置', exact: true }).click();
  await page.locator('input[accept=".json,application/json"]').setInputFiles({
    name: 'rcx.workspace.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      version: 1,
      name: '新团队',
      rocketChat: { url: 'https://chat-new.example.com' },
    })),
  });
  await page.getByRole('button', { name: '应用 1 项' }).click();

  await page.getByRole('button', { name: '连接 Rocket.Chat', exact: true }).click();
  await expect(page.getByText('新团队', { exact: true })).toBeVisible();
  await expect(page.getByText('https://chat-new.example.com', { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder('请输入用户名或邮箱')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('rcx-auth'))).toBeNull();
  expect(pageErrors).toEqual([]);
});

test('打开管家页后可返回消息', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await activateAiRuntimeForTest(page, 'pi');
  const navigation = page.getByRole('navigation');
  await expect(navigation.getByRole('button', { name: '今日', exact: true })).toHaveCount(0);
  await expect(navigation.getByRole('button', { name: 'AI', exact: true })).toHaveCount(0);
  await expect(navigation.getByRole('region', { name: '个人事务' }).getByRole('button', { name: /^管家/ })).toHaveCount(0);
  const butlerSection = navigation.getByRole('region', { name: '管家' });
  await expect(navigation.getByRole('region', { name: '个人事务' })
    .getByRole('button', { name: '工作台', exact: true })).toHaveCount(0);
  await expect(navigation.getByRole('region', { name: '工作区' })
    .getByRole('button', { name: '工作台', exact: true })).toBeVisible();
  await expect(butlerSection.getByRole('button', { name: /^管家/ })).toBeVisible();
  await butlerSection.getByRole('button', { name: /^管家/ }).click();
  await expect(page.getByRole('complementary', { name: 'AI 管家导航' })).toBeVisible();
  await expect(butlerSection.getByRole('group', { name: '管家执行引擎' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '任务', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('rocketx.butler.task-provider'))).toBeNull();
  await page.getByRole('navigation').getByRole('button', { name: /^消息/ }).click();
  await butlerSection.getByRole('button', { name: /^管家/ }).click();
  await expect(page.getByRole('region', { name: '任务', exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('管家在 Web 端提供桌面执行引导并保持只读', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const { pageErrors } = await bootAuthenticated(page);
  await activateAiRuntimeForTest(page, 'pi');
  const navigation = page.getByRole('navigation');
  await navigation.getByRole('region', { name: '管家' }).getByRole('button', { name: /^管家/ }).click();
  await expect(page.getByRole('heading', { name: '在桌面端向管家交代事情' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '给管家的要求' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '配置', exact: true })).toHaveCount(0);
  await expect(page.locator('iframe[title="DSH 原生会话"]')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('Pi 与无 AI 的运行时选择在重启后生效，无 AI 只禁用执行能力', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await activateAiRuntimeForTest(page, 'pi');
  const navigation = page.getByRole('navigation', { name: 'RocketX 主导航' });
  await navigation.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('complementary').getByRole('button', { name: 'AI', exact: true }).click();

  await expect(page.getByText('AI 运行时', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /无 AI/ }).click();
  await expect(page.getByText(/已保存，重启后切换为 无 AI/)).toBeVisible();
  await expect(navigation.getByRole('button', { name: /^管家/ })).toBeVisible();

  await page.reload();
  const restartedNavigation = page.getByRole('navigation', { name: 'RocketX 主导航' });
  await expect(restartedNavigation.getByRole('button', { name: /^管家/ })).toBeVisible();
  await restartedNavigation.getByRole('button', { name: /^管家/ }).click();
  await expect(page.getByText('当前未启用 AI 执行引擎', { exact: true })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'AI 管家导航' })
    .getByRole('button', { name: '我的工作', exact: true })).toBeVisible();
  await restartedNavigation.getByRole('button', { name: /^消息/ }).click();
  await expect(page.getByText('General', { exact: true }).first()).toBeVisible();
  await conversation(page, 'General').click();
  await expect(page.getByRole('button', { name: '配置 AI 托管' })).toBeVisible();
  await expect(page.locator('#room-butler-launcher')).toBeVisible();

  await page.getByRole('navigation', { name: 'RocketX 主导航' })
    .getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('complementary').getByRole('button', { name: 'AI', exact: true }).click();
  await expect(page.getByText('当前运行：无 AI')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('切换会话会渲染对应历史消息', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await conversation(page, 'General').click();
  await expect(page.getByText('Welcome to General', { exact: true })).toBeVisible();
  await conversation(page, 'Project Alpha').click();
  await expect(page.getByText('Project plan updated', { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('普通打开和同会话重开在异步布局增长后都完成贴底（issue #143）', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page, {
    historyOverrides: { 'room-general': scrollHistory('Open generation message') },
  });

  await conversation(page, 'General').click();
  const viewport = page.getByTestId('message-scroll');
  await expect.poll(() => viewport.evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
  )).toBeLessThan(2);

  await viewport.evaluate((element) => {
    const content = element.firstElementChild as HTMLElement;
    const spacer = document.createElement('div');
    spacer.style.height = '600px';
    content.append(spacer);
  });

  await expect.poll(() => viewport.evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
  )).toBeLessThan(2);

  await conversation(page, 'General').click();
  await expect.poll(() => viewport.evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
  )).toBeLessThan(2);
  expect(pageErrors).toEqual([]);
});

test('普通打开的有界帧复核会覆盖第二帧布局增长（issue #299）', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeResizeObserver = window.ResizeObserver;
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      value: class ResizeObserverWithoutMessageListCallbacks {
        private readonly observer: ResizeObserver;

        constructor(callback: ResizeObserverCallback) {
          this.observer = new NativeResizeObserver((entries, observer) => {
            const unrelatedEntries = entries.filter((entry) => {
              const target = entry.target;
              return !(target instanceof HTMLElement && target.closest('[data-testid="message-scroll"]'));
            });
            if (unrelatedEntries.length > 0) callback(unrelatedEntries, observer);
          });
        }

        observe(target: Element, options?: ResizeObserverOptions) {
          this.observer.observe(target, options);
        }

        unobserve(target: Element) {
          this.observer.unobserve(target);
        }

        disconnect() {
          this.observer.disconnect();
        }
      },
    });
  });
  const { pageErrors } = await bootAuthenticated(page, {
    historyOverrides: { 'room-general': scrollHistory('Delayed frame message') },
  });

  const delayedGrowth = page.evaluate(() => new Promise<void>((resolve) => {
    const observer = new MutationObserver(() => {
      const viewport = document.querySelector<HTMLElement>('[data-testid="message-scroll"]');
      if (!viewport) return;
      observer.disconnect();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const spacer = document.createElement('div');
        spacer.style.height = '600px';
        viewport.firstElementChild?.append(spacer);
        resolve();
      }));
    });
    observer.observe(document.getElementById('root')!, { childList: true, subtree: true });
  }));

  await conversation(page, 'General').click();
  await delayedGrowth;
  const viewport = page.getByTestId('message-scroll');
  await expect.poll(() => viewport.evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
  )).toBeLessThan(2);
  expect(pageErrors).toEqual([]);
});

test('历史响应到达之前，已缓存的实时消息首帧就显示在底部', async ({ page }) => {
  const messages = scrollHistory('Cached while inactive').slice(-40);
  const { pageErrors } = await bootAuthenticated(page, {
    historyOverrides: { 'room-general': scrollHistory('Cached while inactive') },
  });
  await page.evaluate(async (messages) => {
    const { useChat } = await import('/src/stores/chat.ts');
    useChat.setState((state) => ({ messages: { ...state.messages, 'room-general': messages } }));
  }, messages);
  let resumeHistory!: () => void;
  const held = new Promise<void>((resolve) => { resumeHistory = resolve; });
  await page.route('**/api/v1/channels.history?**', async (route) => {
    await held;
    await route.fallback();
  });
  const firstLayout = page.evaluate(() => new Promise<number>((resolve) => {
    const observer = new MutationObserver(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="message-scroll"]');
      if (!el?.querySelector('[data-message-id]')) return;
      observer.disconnect();
      resolve(el.scrollHeight - el.clientHeight - el.scrollTop);
    });
    observer.observe(document.getElementById('root')!, { childList: true, subtree: true });
  }));
  try {
    await conversation(page, 'General').click();
    expect(await firstLayout).toBeLessThan(2);
  } finally {
    resumeHistory();
  }
  const viewport = page.getByTestId('message-scroll');
  await expect(viewport.locator('[data-message-id]')).toHaveCount(80);
  await expect.poll(() => viewport.evaluate(
    (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
  )).toBeLessThan(2);
  expect(pageErrors).toEqual([]);
});

test('底部无效滚轮不会取消普通打开后的贴底（issue #143）', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page, {
    historyOverrides: { 'room-general': scrollHistory('Bottom wheel message') },
  });

  await conversation(page, 'General').click();
  const viewport = page.getByTestId('message-scroll');
  await expect.poll(() => viewport.evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
  )).toBeLessThan(2);

  await viewport.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => viewport.evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
  )).toBeLessThan(2);

  await viewport.evaluate((element) => {
    const spacer = document.createElement('div');
    spacer.style.height = '600px';
    element.firstElementChild?.append(spacer);
  });
  await expect.poll(() => viewport.evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
  )).toBeLessThan(2);
  expect(pageErrors).toEqual([]);
});

test('用户主动向上滚动后，异步布局增长不会强制拉回底部（issue #143）', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page, {
    historyOverrides: { 'room-general': scrollHistory('User scroll message') },
  });
  await conversation(page, 'General').click();

  const viewport = page.getByTestId('message-scroll');
  await expect.poll(() => viewport.evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
  )).toBeLessThan(2);
  await viewport.hover();
  await page.mouse.wheel(0, -900);
  await expect.poll(() => viewport.evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
  )).toBeGreaterThan(120);
  const userScrollTop = await viewport.evaluate((element) => element.scrollTop);

  await viewport.evaluate((element) => {
    const spacer = document.createElement('div');
    spacer.style.height = '600px';
    element.firstElementChild?.append(spacer);
  });
  await expect.poll(() => viewport.evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
  )).toBeGreaterThan(600);
  expect(await viewport.evaluate((element) => element.scrollTop)).toBeCloseTo(userScrollTop, 0);
  await expect(page.getByTitle('回到底部')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('显式消息定位优先于普通打开贴底（issue #143）', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page, {
    historyOverrides: {
      'room-general': scrollHistory('Locate filler', {
        index: 18,
        id: 'locate-target',
        text: 'Locate target message',
      }),
    },
  });

  await conversation(page, 'General').click();
  await expect(page.locator('[data-message-id="locate-target"]')).toHaveCount(1);
  await conversation(page, 'Project Alpha').click();
  await page.keyboard.press('Control+Shift+F');
  const search = page.getByRole('dialog', { name: '全局搜索' });
  await search.getByRole('textbox').fill('Locate target message');
  await search.getByText('Locate target message', { exact: true }).click();

  const target = page.locator('[data-message-id="locate-target"]');
  await expect(target).toBeVisible();
  await expect.poll(() => target.evaluate((element) => {
    const viewport = element.closest('[data-testid="message-scroll"]');
    if (!viewport) return false;
    const targetRect = element.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    return targetRect.top >= viewportRect.top && targetRect.bottom <= viewportRect.bottom;
  })).toBe(true);
  await expect.poll(() => page.getByTestId('message-scroll').evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
  )).toBeGreaterThan(120);
  // 旧消息上方的附件在定位后才撑开，目标应继续留在可视区。
  await target.evaluate((element) => {
    const firstMessage = element.closest('[data-testid="message-scroll"]')!.querySelector<HTMLElement>('[data-message-id]')!;
    firstMessage.style.minHeight = '1200px';
  });
  await expect(target).toBeInViewport();
  await page.getByTestId('message-scroll').hover();
  await page.mouse.wheel(0, 800);
  await expect(target).not.toBeInViewport();
  await target.evaluate(async (element) => {
    const firstMessage = element.closest('[data-testid="message-scroll"]')!.querySelector<HTMLElement>('[data-message-id]')!;
    firstMessage.style.minHeight = '1500px';
    await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  });
  await expect(target).not.toBeInViewport();
  expect(pageErrors).toEqual([]);
});

test('看过历史消息后从其他模块重新打开消息会回到最新', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page, {
    historyOverrides: { 'room-general': scrollHistory('Module return') },
  });
  await conversation(page, 'General').click();
  await page.evaluate(async () => {
    const { useChat } = await import('/src/stores/chat.ts');
    await useChat.getState().jumpToMessage('Module return-18', 'room-general');
  });
  await expect(page.locator('[data-message-id="Module return-18"]')).toBeInViewport();
  await page.getByTitle('设置', { exact: true }).click();
  await expect(page.getByTestId('message-scroll')).toHaveCount(0);
  await page.getByTitle('消息', { exact: true }).click();
  await expect.poll(() => page.getByTestId('message-scroll').evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
  )).toBeLessThan(2);
  expect(pageErrors).toEqual([]);
});

test('系统消息也能在长会话中定位并高亮', async ({ page }) => {
  const messages = scrollHistory('System row');
  const { pageErrors } = await bootAuthenticated(page, {
    historyOverrides: {
      'room-general': messages.map((message, i) => i === 18 ? { ...message, t: 'r' } : message),
    },
  });
  await conversation(page, 'General').click();
  await page.evaluate(async () => {
    const { useChat } = await import('/src/stores/chat.ts');
    await useChat.getState().jumpToMessage('System row-18', 'room-general');
  });
  const target = page.locator('[data-message-id="System row-18"]');
  await expect(target).toBeInViewport();
  await expect(target).toHaveClass(/bg-primary-light/);
  expect(pageErrors).toEqual([]);
});

test('发送到其他房间时保留当前会话的历史阅读位置', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page, {
    historyOverrides: { 'room-general': scrollHistory('Background send') },
  });
  await conversation(page, 'General').click();
  await page.evaluate(async () => {
    const { useChat } = await import('/src/stores/chat.ts');
    await useChat.getState().jumpToMessage('Background send-18', 'room-general');
  });
  const target = page.locator('[data-message-id="Background send-18"]');
  await expect(target).toBeInViewport();
  await page.evaluate(async () => {
    const { useChat } = await import('/src/stores/chat.ts');
    await useChat.getState().send('给项目组同步', { rid: 'room-project' });
  });
  await expect(target).toBeInViewport();
  expect(pageErrors).toEqual([]);
});

async function checkDistantQuote(page: Page, realtimeContext: boolean) {
  const history = Array.from({ length: 420 }, (_, index) => ({
    _id: `long-${index}`, rid: 'room-general', msg: `历史记录 ${index}`,
    ts: new Date(Date.parse(NOW) + index * 1000).toISOString(), u: ALICE,
  }));
  const target = history[45]!;
  const latest = { ...history.at(-1)!, attachments: [{
    message_link: `/channel/general?msg=${target._id}`, author_name: 'Alice', text: '查看原记录',
  }] };
  const { pageErrors } = await bootAuthenticated(page, {
    historyOverrides: { 'room-general': realtimeContext ? [...history.slice(0, -1), latest] : [latest] },
  });
  const pageEnds: string[] = [];
  await page.route('**/api/v1/channels.history*', async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get('roomId') !== target.rid) return route.fallback();
    const end = params.get('latest');
    if (end) pageEnds.push(end);
    const rows = [...history.slice(0, -1), latest].filter((item) => !end || item.ts < end);
    return fulfillJson(route, { messages: rows.reverse().slice(0, Number(params.get('count') ?? 50)) });
  });
  await page.route('**/api/v1/chat.getMessage*', (route) => fulfillJson(route, { message: target }));
  await conversation(page, 'General').click();
  await page.getByRole('button', { name: /查看原记录/ }).click();
  await expect(page.locator(`[data-message-id="${target._id}"]`)).toBeInViewport();
  await expect(page.locator('[data-message-id="long-44"]')).toBeAttached();
  expect(pageEnds.length).toBe(realtimeContext ? 0 : 1);
  if (realtimeContext) await expect(page.locator('[data-message-id="long-46"]')).toBeAttached();
  await page.evaluate(async ({ rid, mid }) => {
    const { useChat } = await import('/src/stores/chat.ts');
    await useChat.getState().deleteMessage({ _id: mid, rid });
  }, { rid: target.rid, mid: 'long-44' });
  await expect(page.locator('[data-message-id="long-44"]')).toHaveCount(0);
  await page.getByRole('button', { name: '返回最新消息' }).click();
  await expect(page.locator('[data-message-id="long-419"]')).toBeInViewport();
  const scroll = page.getByTestId('message-scroll');
  await scroll.hover();
  await page.mouse.wheel(0, -10000);
  await expect(page.locator('[data-message-id="long-369"]')).toBeAttached();
  expect(pageErrors).toEqual([]);
}

test('引用可以定位五页以前的消息，返回最新后分页仍连续', async ({ page }) => {
  await checkDistantQuote(page, true);
});

test('实时上下文不可用时仍能打开五页以前的引用', async ({ page }) => {
  await checkDistantQuote(page, false);
});

test('点击聊天正文里的本站永久链接会在客户端定位另一房间的消息', async ({ page, context }) => {
  const target = scrollHistory('Permalink target')[18]!;
  const link = `${SERVER}/channel/general?msg=${encodeURIComponent(target._id)}`;
  const { pageErrors } = await bootAuthenticated(page, {
    historyOverrides: {
      'room-general': scrollHistory('Permalink target'),
      'room-project': [{ _id: 'link-source', rid: 'room-project', ts: NOW, u: ALICE, msg: `[查看结论](${link})` }],
    },
  });
  await conversation(page, 'Project Alpha').click();
  await page.getByRole('link', { name: '查看结论' }).click();
  await expect(page.locator(`[data-message-id="${target._id}"]`)).toBeInViewport();
  expect(context.pages()).toHaveLength(1);
  expect(pageErrors).toEqual([]);
});

test('通知点击话题回复时按消息真实房间打开话题并定位回复（issue #381）', async ({ page }) => {
  const threadRoot = {
    _id: 'notification-thread-root',
    rid: 'room-general',
    msg: 'Notification thread root',
    ts: '2026-07-17T08:00:00.000Z',
    u: ALICE,
    tcount: 1,
    replies: [ME._id],
  };
  const threadReply = {
    _id: 'notification-thread-reply',
    rid: 'room-general',
    tmid: threadRoot._id,
    msg: 'Notification thread reply target',
    ts: '2026-07-17T08:01:00.000Z',
    u: ALICE,
  };
  const { pageErrors } = await bootAuthenticated(page, {
    historyOverrides: {
      'room-general': [
        ...scrollHistory('Notification filler'),
        threadRoot,
        threadReply,
      ],
    },
  });

  await conversation(page, 'Project Alpha').click();
  // 真实话题接口只返回回复，主消息也可能早已不在房间最近一页内。
  await page.route('**/api/v1/channels.history*', (route) => fulfillJson(route, { messages: [] }));
  await page.route('**/api/v1/chat.getThreadMessages*', (route) =>
    fulfillJson(route, { messages: [threadReply], total: 1 }));
  await page.evaluate(async ({ mid, rid }) => {
    const { useChat } = await import('/src/stores/chat.ts');
    await useChat.getState().jumpToMessage(mid, rid);
  }, { mid: threadReply._id, rid: 'room-project' });

  await expect(page.getByText('话题', { exact: true })).toBeVisible();
  const target = page.locator('[data-message-id="notification-thread-reply"]');
  await expect(target).toBeVisible();
  await expect(target).toHaveClass(/bg-primary-light/);
  expect(pageErrors).toEqual([]);
});

test('较晚的会话切换会取消仍在查询的话题通知定位（issue #381）', async ({ page }) => {
  const threadReply = {
    _id: 'delayed-notification-thread-reply',
    rid: 'room-general',
    tmid: 'delayed-notification-thread-root',
    msg: 'Delayed notification thread reply',
    ts: '2026-07-17T08:01:00.000Z',
    u: ALICE,
  };
  const { pageErrors } = await bootAuthenticated(page);
  await conversation(page, 'Project Alpha').click();

  let markRequested = () => {};
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  let releaseResponse = () => {};
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await page.route('**/api/v1/chat.getMessage*', async (route) => {
    const mid = new URL(route.request().url()).searchParams.get('msgId');
    if (mid !== threadReply._id) return route.fallback();
    markRequested();
    await responseGate;
    return fulfillJson(route, { message: threadReply });
  });

  const navigation = page.evaluate(async ({ mid, rid }) => {
    const { useChat } = await import('/src/stores/chat.ts');
    await useChat.getState().jumpToMessage(mid, rid);
  }, { mid: threadReply._id, rid: threadReply.rid });
  await requested;
  await conversation(page, 'Project Alpha').click();
  releaseResponse();
  await navigation;

  expect(await page.evaluate(async () => {
    const { useChat } = await import('/src/stores/chat.ts');
    const state = useChat.getState();
    return {
      activeRid: state.activeRid,
      rightPanel: state.rightPanel,
      leakedIntoProject: state.messages['room-project']?.some(
        (message) => message._id === 'delayed-notification-thread-reply',
      ) ?? false,
    };
  })).toEqual({
    activeRid: 'room-project',
    rightPanel: null,
    leakedIntoProject: false,
  });
  expect(pageErrors).toEqual([]);
});

test('精简模式关闭 AI 入口但保留常规聊天流程（issue #264）', async ({ page }) => {
  const aiModuleRequests: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (
      [
        '/src/components/ButlerPollerBridge.tsx',
        '/src/pages/ButlerPage.tsx',
        '/src/pages/CodexPage.tsx',
        '/src/components/SummaryPanel.tsx',
        '/src/components/AiSettings.tsx',
      ].some((marker) => url.includes(marker))
    ) {
      aiModuleRequests.push(url);
    }
  });
  await page.addInitScript(() => {
    localStorage.setItem('rcx-runtime-mode-v1', 'performance');
  });
  const { sentMessages, pageErrors } = await bootAuthenticated(page);

  await expect(page.getByRole('navigation').getByRole('button', { name: /^管家/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Codex', exact: true })).toHaveCount(0);

  await conversation(page, 'General').click();
  await expect(page.getByRole('button', { name: '配置 AI 托管' })).toHaveCount(0);
  await expect(page.locator('#room-butler-launcher')).toHaveCount(0);

  await page.getByPlaceholder(/输入消息/).fill('performance mode smoke');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('performance mode smoke', { exact: true })).toBeVisible();
  expect(sentMessages.at(-1)).toMatchObject({ msg: 'performance mode smoke', rid: 'room-general' });

  await page.keyboard.press('Control+Shift+F');
  const search = page.getByRole('dialog', { name: '全局搜索' });
  await search.getByRole('textbox').fill('performance mode smoke');
  await expect(search.getByText('performance mode smoke', { exact: true })).toBeVisible();
  await expect(search.getByRole('button', { name: /问管家/ })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('complementary').getByRole('button', { name: 'AI', exact: true })).toHaveCount(0);
  await page.getByRole('complementary').getByRole('button', { name: '桌面端', exact: true }).click();
  await expect(page.getByText('精简模式', { exact: true })).toBeVisible();

  expect(aiModuleRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('聊天消息渲染块公式、行内公式和可访问 MathML（issue #218）', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await conversation(page, 'General').click();
  await page.evaluate(async () => {
    const load = new Function('return import("/src/stores/chat.ts")') as () => Promise<{
      useChat: {
        getState: () => { messages: Record<string, unknown[]> };
        setState: (state: { messages: Record<string, unknown[]> }) => void;
      };
    }>;
    const { useChat } = await load();
    const state = useChat.getState();
    useChat.setState({
      messages: {
        ...state.messages,
        'room-general': [
          ...(state.messages['room-general'] ?? []),
          {
            _id: 'formula-218',
            rid: 'room-general',
            msg: [
              '[',
              'S_{\\text{eff}}=S_{\\max}',
              ']',
              '',
              '[',
              'F_{\\text{eff}}=P\\times S_{\\text{eff}}',
              ']',
              '',
              '行内公式 $E=mc^2$',
              '',
              '```',
              '$not_math$',
              '```',
            ].join('\n'),
            ts: '2026-07-24T08:00:00.000Z',
            u: { _id: 'user-alice', username: 'alice', name: 'Alice' },
          },
        ],
      },
    });
  });

  await expect(page.locator('[data-rocketx-math="display"] .katex')).toHaveCount(2);
  await expect(page.locator('[data-rocketx-math="inline"] .katex')).toHaveCount(1);
  await expect(page.locator('[data-rocketx-math] .katex-mathml')).toHaveCount(3);
  await expect(page.locator('pre').filter({ hasText: '$not_math$' })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('普通消息完整渲染标题、列表、引用、代码块和表格（issue #319）', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 2400, height: 900 });
  const { pageErrors } = await bootAuthenticated(page);
  await conversation(page, 'General').click();
  await page.evaluate(async () => {
    const load = new Function('return import("/src/stores/chat.ts")') as () => Promise<{
      useChat: {
        getState: () => { messages: Record<string, unknown[]> };
        setState: (state: { messages: Record<string, unknown[]> }) => void;
      };
    }>;
    const { useChat } = await load();
    const state = useChat.getState();
    useChat.setState({
      messages: {
        ...state.messages,
        'room-general': [
          ...(state.messages['room-general'] ?? []),
          {
            _id: 'markdown-319',
            rid: 'room-general',
            msg: [
              '## 发布检查',
              '',
              '正文包含 **重点** 与 [文档](https://example.com/docs)。',
              '',
              '- [x] 回归通过',
              '- [ ] 等待发布',
              '',
              '> 保持反馈清晰可读。',
              '',
              '| 门禁 | Windows | macOS | Linux | 发布产物 | 状态 |',
              '| --- | --- | --- | --- | --- | --- |',
              '| Typecheck | x64 slim + full | universal application bundle | AppImage + deb + rpm | signed update archives | 通过 |',
              '| UI | Chromium | WebKit | Firefox | screenshots | 通过 |',
              '',
              '```ts',
              'const release = true;',
              '```',
            ].join('\n'),
            ts: '2026-08-15T08:00:00.000Z',
            u: { _id: 'user-alice', username: 'alice', name: 'Alice' },
          },
        ],
      },
    });
  });

  const message = page.locator('[data-message-id="markdown-319"]');
  const markdown = message.locator('.rocketx-markdown--chat');
  await expect(markdown).toHaveAttribute('data-variant', 'chat');
  await expect(markdown.getByRole('heading', { name: '发布检查', level: 2 })).toBeVisible();
  await expect(markdown.getByRole('link', { name: '文档' })).toHaveAttribute('href', 'https://example.com/docs');
  await expect(markdown.locator('.markdown-list-item')).toHaveCount(2);
  await expect(markdown.locator('input[type="checkbox"]')).toHaveCount(2);
  await expect(markdown.locator('blockquote')).toContainText('保持反馈清晰可读');
  await expect(markdown.locator('table')).toContainText('Typecheck');
  await expect(markdown.locator('pre')).toContainText('const release = true;');
  const markdownLayout = await markdown.evaluate((element) => ({
    markdownWidth: element.getBoundingClientRect().width,
    paragraphWidth: element.querySelector('p')?.getBoundingClientRect().width ?? 0,
    tableViewportWidth: element.querySelector<HTMLElement>('.markdown-table-wrap')?.clientWidth ?? 0,
    bubbleBackground: getComputedStyle(element.parentElement!).backgroundColor,
    messageViewportWidth: element.closest('[data-testid="message-scroll"]')?.getBoundingClientRect().width ?? 0,
  }));
  expect(markdownLayout.markdownWidth).toBeGreaterThan(markdownLayout.messageViewportWidth * 0.8);
  expect(markdownLayout.paragraphWidth).toBeGreaterThan(520);
  expect(markdownLayout.paragraphWidth).toBeLessThan(800);
  expect(markdownLayout.tableViewportWidth).toBeGreaterThan(markdownLayout.messageViewportWidth * 0.8);
  expect(markdownLayout.bubbleBackground).toBe('rgba(0, 0, 0, 0)');
  await message.screenshot({ path: testInfo.outputPath('markdown-message-319.png') });

  await page.setViewportSize({ width: 390, height: 844 });
  const narrowLayout = await markdown.evaluate((element) => {
    const tableWrap = element.querySelector<HTMLElement>('.markdown-table-wrap')!;
    return {
      overflowX: getComputedStyle(tableWrap).overflowX,
      viewportWidth: tableWrap.clientWidth,
      scrollWidth: tableWrap.scrollWidth,
      pageWidth: document.documentElement.scrollWidth,
      windowWidth: window.innerWidth,
    };
  });
  expect(narrowLayout.overflowX).toBe('auto');
  expect(narrowLayout.scrollWidth).toBeGreaterThan(narrowLayout.viewportWidth);
  expect(narrowLayout.pageWidth).toBeLessThanOrEqual(narrowLayout.windowWidth);
  expect(pageErrors).toEqual([]);
});

test('AI 托管完整回答使用 Codex 式宽版文档流', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 2400, height: 900 });
  await page.addInitScript(() => localStorage.setItem('rcx-theme', 'dark'));
  const { pageErrors } = await bootAuthenticated(page);
  await conversation(page, 'General').click();
  await page.evaluate(async ({ me }) => {
    const load = new Function('return import("/src/stores/chat.ts")') as () => Promise<{
      useChat: {
        getState: () => { messages: Record<string, unknown[]> };
        setState: (state: { messages: Record<string, unknown[]> }) => void;
      };
    }>;
    const { useChat } = await load();
    const state = useChat.getState();
    useChat.setState({
      messages: {
        ...state.messages,
        'room-general': [
          ...(state.messages['room-general'] ?? []),
          {
            _id: 'hosted-agent-document',
            rid: 'room-general',
            msg: [
              '🤖 DeepSeek',
              '以下是 **General** 群的聊天总结：',
              '',
              '## 房间概览',
              '',
              '- **性质：** 测试群，绝大多数消息是功能验证与自动化测试',
              '- **参与者：** Admin、张三、李四',
              '',
              '## 测试类内容',
              '',
              '1. 历史消息批量导入与引用验证',
              '2. Markdown 标题、列表、表格、代码块与附件验证',
              '3. 自动化测试和聊天记录转发',
              '',
              '| 门禁 | Windows | macOS | Linux | 发布产物 | 结果 |',
              '| --- | --- | --- | --- | --- | --- |',
              '| 桌面构建 | x64 slim + full | universal | AppImage + deb + rpm | SHA256SUMS | 全部通过 |',
            ].join('\n'),
            ts: '2026-08-16T08:00:00.000Z',
            u: me,
          },
        ],
      },
    });
  }, { me: ME });

  const row = page.locator('[data-message-id="hosted-agent-document"]');
  await row.scrollIntoViewIfNeeded();
  await page.locator('main').screenshot({ path: testInfo.outputPath('room-agent-document-layout.png') });
  await expect(row).toHaveClass(/rocketx-agent-answer-row/);
  await expect(row.getByText('DeepSeek', { exact: true })).toBeVisible();
  const answer = row.locator('.rocketx-agent-answer');
  const body = row.locator('.rocketx-agent-answer-body');
  const tableWrap = body.locator('.markdown-table-wrap');
  await expect(body.getByRole('heading', { name: '房间概览', level: 2 })).toBeVisible();
  await expect(body).not.toContainText('🤖 DeepSeek');
  await expect(tableWrap.getByRole('table')).toContainText('SHA256SUMS');

  const layout = await answer.evaluate((element) => {
    const paragraph = element.querySelector('p');
    const paragraphRect = paragraph?.getBoundingClientRect();
    const tableWrap = element.querySelector<HTMLElement>('.markdown-table-wrap');
    return {
      answerWidth: element.getBoundingClientRect().width,
      background: getComputedStyle(element.querySelector('.rocketx-agent-answer-body')!).backgroundColor,
      headingFontSize: Number.parseFloat(getComputedStyle(element.querySelector('h2')!).fontSize),
      paragraphWidth: paragraphRect?.width ?? 0,
      tableViewportWidth: tableWrap?.clientWidth ?? 0,
      tableScrollWidth: tableWrap?.scrollWidth ?? 0,
      messageViewportWidth: element.closest('[data-testid="message-scroll"]')?.getBoundingClientRect().width ?? 0,
    };
  });
  expect(layout.answerWidth).toBeGreaterThan(layout.messageViewportWidth * 0.8);
  expect(layout.background).toBe('rgba(0, 0, 0, 0)');
  expect(layout.headingFontSize).toBe(17);
  expect(layout.paragraphWidth).toBeGreaterThan(520);
  expect(layout.paragraphWidth).toBeLessThan(880);
  expect(layout.tableViewportWidth).toBeGreaterThan(layout.messageViewportWidth * 0.8);
  expect(layout.tableScrollWidth).toBeGreaterThanOrEqual(layout.tableViewportWidth);
  expect(pageErrors).toEqual([]);
});

test('底部消息的表情面板加载完整分类后仍留在视口内（issue #207）', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await conversation(page, 'General').click();
  await page.evaluate(async () => {
    const load = new Function('return import("/src/stores/chat.ts")') as () => Promise<{
      useChat: {
        getState: () => { messages: Record<string, unknown[]> };
        setState: (state: { messages: Record<string, unknown[]> }) => void;
      };
    }>;
    const { useChat } = await load();
    const state = useChat.getState();
    useChat.setState({
      messages: {
        ...state.messages,
        'room-general': Array.from({ length: 40 }, (_, index) => ({
          _id: `reaction-${index}`,
          rid: 'room-general',
          msg: index === 39 ? 'Bottom reaction message' : `Reaction filler ${index}`,
          ts: new Date(Date.parse('2026-07-17T08:00:00.000Z') + index * 1000).toISOString(),
          u: { _id: 'user-alice', username: 'alice', name: 'Alice' },
        })),
      },
    });
  });
  const message = page.getByText('Bottom reaction message', { exact: true });
  await expect(message).toBeVisible();
  await message.scrollIntoViewIfNeeded();
  await message.hover();
  await page.getByRole('button', { name: '更多表情' }).click();

  const search = page.getByPlaceholder('搜索表情');
  const picker = search.locator('xpath=../..');
  await expect(search).toBeVisible();
  await expect(picker.locator('[data-emoji-section]').first()).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => {
    const box = await picker.boundingBox();
    const viewport = page.viewportSize();
    return !!box && !!viewport && box.y >= 8 && box.y + box.height <= viewport.height - 8;
  }).toBe(true);
  expect(pageErrors).toEqual([]);
});

test('文件拖拽离开聊天区或窗口后会取消发送遮罩（issue #194）', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await conversation(page, 'General').click();
  const chatArea = page.locator('main');
  const overlay = page.getByText('松开即可发送文件', { exact: true });

  const dragFileOverChat = () => chatArea.evaluate((element) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['test'], 'test.txt', { type: 'text/plain' }));
    element.dispatchEvent(new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      dataTransfer,
    }));
  });

  await dragFileOverChat();
  await expect(overlay).toBeVisible();
  await chatArea.locator('header').evaluate((element) => {
    element.dispatchEvent(new DragEvent('dragleave', {
      bubbles: true,
      relatedTarget: document.body,
    }));
  });
  await expect(overlay).toHaveCount(0);

  await dragFileOverChat();
  await expect(overlay).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(overlay).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('收起分组栏后不产生水平滚动（issue #114）', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('rcx-folders', JSON.stringify(Array.from({ length: 20 }, (_, index) => ({
      id: `folder-${index}`,
      name: `非常长的分组名称-${index}`,
      rids: [],
    }))));
  });
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('button', { name: '收起分组栏' }).click();
  const aside = page.getByRole('button', { name: '展开分组栏' }).locator('xpath=ancestor::aside');
  await expect(aside).toBeVisible();
  await expect.poll(() => aside.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(pageErrors).toEqual([]);
});

test('发送消息会乐观上屏并提交一次', async ({ page }) => {
  const { sentMessages, pageErrors } = await bootAuthenticated(page);
  await conversation(page, 'General').click();
  await page.getByPlaceholder(/输入消息/).fill('UI smoke message');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('UI smoke message', { exact: true })).toBeVisible();
  await expect.poll(() => sentMessages.length).toBe(1);
  expect(sentMessages[0]?.msg).toBe('UI smoke message');
  expect(pageErrors).toEqual([]);
});

test('文字和图片确认后作为同一条上传消息发送（issue #155）', async ({ page }) => {
  const { uploadedMessages, pageErrors } = await bootAuthenticated(page);
  await conversation(page, 'General').click();
  const composer = page.getByPlaceholder(/输入消息/);
  await composer.fill('图文说明');
  await page.locator('input[accept="image/*"]').setInputFiles({
    name: 'diagram.png',
    mimeType: 'image/png',
    buffer: Buffer.from('image-bytes'),
  });

  const dialog = page.getByRole('dialog', { name: '发送文件给 General' });
  const caption = dialog.getByRole('textbox', { name: '图片说明' });
  await expect(caption).toBeFocused();
  await expect(caption).toHaveValue('图文说明');
  await caption.fill('在确认弹窗补充的说明');
  await caption.press('Shift+Enter');
  await caption.type('第二行');
  await dialog.getByRole('button', { name: '发送（1）' }).click();

  await expect.poll(() => uploadedMessages.length).toBe(1);
  expect(uploadedMessages[0]?.msg).toBe('在确认弹窗补充的说明\n第二行');
  await expect(composer).toHaveValue('');
  expect(pageErrors).toEqual([]);
});

test('主 Composer 贴纸首次打开后动态加载，并沿用现有上传确认链路发送（issue #250）', async ({ page }) => {
  const { uploadedMessages, pageErrors } = await bootAuthenticated(page);
  const stickerRequests: string[] = [];
  const dynamicImports: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    const pathname = new URL(url).pathname;
    if (pathname.includes('/stickers/')) stickerRequests.push(pathname);
    if (url.includes('StickerPicker.tsx') || url.includes('stickerLoader.ts')) dynamicImports.push(url);
  });

  await conversation(page, 'General').click();
  const composer = page.getByPlaceholder(/输入消息/);
  await composer.fill('贴纸说明');
  expect(stickerRequests).toEqual([]);
  expect(dynamicImports).toEqual([]);

  await page.getByRole('button', { name: '贴纸' }).click();
  const search = page.getByPlaceholder('搜索贴纸');
  await expect(search).toBeVisible();
  await expect.poll(() => dynamicImports.some((url) => url.includes('StickerPicker.tsx'))).toBe(true);
  await expect.poll(() => stickerRequests.some((path) => path.endsWith('/stickers/index.json'))).toBe(true);
  await expect(page.locator('[data-sticker-group="常用回应"]').first()).toBeVisible();
  await expect(page.locator('[data-sticker-group="进度状态"]').first()).toBeVisible();

  await search.fill('赞');
  const sticker = page.getByRole('button', { name: '发送贴纸 赞', exact: true });
  await expect(sticker).toBeVisible();
  await expect(sticker).toHaveAttribute('title', '赞');
  await expect(sticker.getByText('赞', { exact: true })).toHaveCount(0);
  await sticker.click();

  const dialog = page.getByRole('dialog', { name: '发送文件给 General' });
  await expect(dialog.getByText('贴纸说明', { exact: true })).toBeVisible();
  await expect(dialog.getByAltText('thumbs-up.png')).toBeVisible();
  await dialog.getByRole('button', { name: '发送（1）' }).click();

  await expect.poll(() => uploadedMessages.length).toBe(1);
  expect(uploadedMessages[0]?.msg).toBe('贴纸说明');

  await page.getByRole('button', { name: '贴纸' }).click();
  await expect(page.getByText('最近使用', { exact: true })).toBeVisible();
  const recentSticker = page.getByRole('button', { name: '发送贴纸 赞' }).first();
  await expect(recentSticker).toBeVisible();
  await expect(recentSticker).toHaveAttribute('title', '赞');
  await expect(recentSticker.getByText('赞', { exact: true })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('主 Composer 贴纸支持导入本机图片到个人贴纸库并沿用现有上传确认链路发送（issue #265）', async ({ page }) => {
  await installFullTauriMock(page);
  await page.addInitScript(() => {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03, 0x04];
    (window as unknown as {
      __dialogOpenResponses?: Array<string | string[] | null>;
      __setMockFsFile?: (path: string, bytes: number[]) => void;
    }).__dialogOpenResponses = ['C:\\Import\\xxxxxx_K20_DE39_to_xxxxxx.png'];
    (window as unknown as {
      __dialogOpenResponses?: Array<string | string[] | null>;
      __setMockFsFile?: (path: string, bytes: number[]) => void;
    }).__setMockFsFile?.('C:\\Import\\xxxxxx_K20_DE39_to_xxxxxx.png', png);
  });
  const { uploadedMessages, pageErrors } = await bootAuthenticated(page);

  await conversation(page, 'General').click();
  await page.getByPlaceholder(/输入消息/).fill('个人贴纸说明');
  await page.getByRole('button', { name: '贴纸' }).click();
  await expect(page.getByRole('button', { name: '导入图片' })).toBeVisible();
  await page.getByRole('button', { name: '导入图片' }).click();
  await expect(page.locator('[data-sticker-group="我的贴纸"]').first()).toBeVisible();

  const personalSticker = page.getByRole('button', { name: '发送贴纸 xxxxxx_K20_DE39_to_xxxxxx' });
  await expect(personalSticker).toBeVisible();
  await expect(personalSticker).toHaveAttribute('title', 'xxxxxx_K20_DE39_to_xxxxxx');
  await expect(personalSticker.getByText('xxxxxx_K20_DE39_to_xxxxxx', { exact: true })).toHaveCount(0);
  await personalSticker.click();

  const dialog = page.getByRole('dialog', { name: '发送文件给 General' });
  await expect(dialog.getByText('个人贴纸说明', { exact: true })).toBeVisible();
  await expect(dialog.getByAltText('xxxxxx_K20_DE39_to_xxxxxx.png')).toBeVisible();
  await dialog.getByRole('button', { name: '发送（1）' }).click();

  await expect.poll(() => uploadedMessages.length).toBe(1);
  expect(uploadedMessages[0]?.msg).toBe('个人贴纸说明');
  expect(pageErrors).toEqual([]);
});

test('收到的图片消息可右键收藏到个人贴纸库并在贴纸面板复用（issue #265）', async ({ page }) => {
  await installFullTauriMock(page);
  const { pageErrors } = await bootAuthenticated(page, { includeStickerFixture: true });

  await conversation(page, 'General').click();
  await page.getByRole('button', { name: /收藏示例\.png/ }).last().click({ button: 'right' });
  await expect(page.getByRole('button', { name: '收藏到贴纸库' })).toBeVisible();
  await page.getByRole('button', { name: '收藏到贴纸库' }).click();

  await page.getByRole('button', { name: '贴纸' }).click();
  await expect(page.locator('[data-sticker-group="我的贴纸"]').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '发送贴纸 收藏示例' })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('右键回复提交 Rocket.Chat 可展开的官方引用格式（issue #126）', async ({ page }) => {
  const { sentMessages, pageErrors } = await bootAuthenticated(page);
  await conversation(page, 'General').click();
  await page.getByText('Welcome to General', { exact: true }).click({ button: 'right' });
  await page.getByText('回复', { exact: true }).click();
  await page.getByPlaceholder(/输入消息/).fill('Reply from UI');
  await page.getByRole('button', { name: '发送', exact: true }).click();

  await expect.poll(() => sentMessages.length).toBe(1);
  expect(sentMessages[0]?.msg).toBe(
    `[ ](${SERVER}/channel/general?msg=general-welcome) Reply from UI`,
  );
  expect(pageErrors).toEqual([]);
});

test('引用正文为空时显示 Rocket.Chat 嵌套附件内容（issue #289）', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await conversation(page, 'General').click();

  const quote = page.getByTitle('点击跳转到原消息');
  await expect(quote).toContainText('Build Bot');
  await expect(quote).toContainText('构建失败');
  await expect(quote).toContainText('main · #128');
  expect(pageErrors).toEqual([]);
});

test('消息待办可记录承诺对象，并保留在确定性的待办界面', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await conversation(page, 'General').click();
  await page.getByText('Welcome to General', { exact: true }).click({ button: 'right' });
  await page.getByRole('button', { name: '标记为待办' }).click();
  const committedTo = page.getByPlaceholder('例如：张三');
  const waitingFor = page.getByPlaceholder('例如：李四');
  await committedTo.fill('张三');
  await waitingFor.fill('李四');
  await expect(committedTo).toHaveValue('');
  await committedTo.fill('张三');
  await expect(waitingFor).toHaveValue('');
  await page.getByRole('button', { name: '加入待办' }).click();
  const [saved] = await readStoredTodos(page);
  expect(saved).toMatchObject({ committedTo: '张三' });
  await page.getByRole('navigation').getByRole('button', { name: /^待办/ }).click();
  await expect(page.getByRole('main').getByText('1 项', { exact: true })).toBeVisible();
  await expect(page.getByText('Welcome to General', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '标记为完成' }).click();
  await expect(page.getByRole('main').getByText('0 项', { exact: true })).toBeVisible();
  const [completed] = await readStoredTodos(page);
  expect(completed).toMatchObject({ done: true, committedTo: '张三' });
  expect(pageErrors).toEqual([]);
});

test('编辑旧双值承诺待办时归一化为单一方向', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('rcx-todos', JSON.stringify([{
      id: 'legacy-commitment',
      source: 'manual',
      note: '旧双值承诺',
      done: false,
      createdAt: 1,
      committedTo: '张三',
      waitingFor: '李四',
    }]));
  });
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('navigation').getByRole('button', { name: /^待办/ }).click();
  await page.getByText('旧双值承诺', { exact: true }).hover();
  await page.getByTitle('编辑').click();
  await page.getByRole('button', { name: '保存' }).click();

  const [saved] = await readStoredTodos(page);
  expect(saved?.committedTo).toBe('张三');
  expect(saved).not.toHaveProperty('waitingFor');
  expect(pageErrors).toEqual([]);
});

test('Azure DevOps 卡片会随聊天栏收窄（issue #116）', async ({ page }) => {
  const workItem = {
    id: 128,
    title: 'A very long work item title that must wrap inside a narrow chat column',
    type: 'Bug',
    state: 'Active',
    priority: 1,
    project: 'RocketChatX-Project-With-A-Very-Long-Name',
    assignedTo: 'Test User',
    webUrl: 'http://ado.example/RocketChatX/_workitems/edit/128',
  };
  await installAdoDirectMock(page, workItem);
  await page.addInitScript(() => {
    localStorage.setItem('rcx-workbench', JSON.stringify({
      adoBase: `${location.origin}/ado`,
      auth: 'none',
      account: 'tester',
    }));
    localStorage.setItem('rcx-ado-web', `${location.origin}/ado`);
  });
  const { pageErrors } = await bootAuthenticated(page);
  await conversation(page, 'General').click();
  await page.getByPlaceholder(/输入消息/).fill('#128');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const title = page.getByText(workItem.title, { exact: true });
  await expect(title).toBeVisible();
  await page.getByTitle('查看群信息').first().click();
  const card = title.locator('xpath=ancestor::span[contains(@class,"inline-block")]');
  await expect.poll(() => card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(pageErrors).toEqual([]);
});

test('Basic 过程的层级模板文案逐项对应实际工作项预览（issue #325）', async ({ page }, testInfo) => {
  const adoWrites: string[] = [];
  await page.route('**/ado/**', (route) => {
    const request = route.request();
    const path = decodeURIComponent(new URL(request.url()).pathname).toLocaleLowerCase();
    if (request.method() !== 'GET') adoWrites.push(`${request.method()} ${path}`);
    if (path.endsWith('/_apis/connectiondata')) {
      return fulfillJson(route, {
        authenticatedUser: {
          id: 'ado-user',
          customDisplayName: 'Test User',
          properties: { Account: { $value: 'tester' } },
        },
      });
    }
    if (path.endsWith('/_apis/projects')) {
      return fulfillJson(route, { value: [{ id: 'basic-project', name: 'Basic Project' }] });
    }
    if (path.endsWith('/basic project/_apis/wit/workitemtypes')) {
      return fulfillJson(route, {
        value: [{ name: 'Epic' }, { name: 'Issue' }, { name: 'Task' }],
      });
    }
    if (path.endsWith('/basic project/_apis/work/processconfiguration')) {
      return fulfillJson(route, {
        portfolioBacklogs: [{ workItemTypes: [{ name: 'Epic' }] }],
        requirementBacklog: { workItemTypes: [{ name: 'Issue' }] },
        taskBacklog: { workItemTypes: [{ name: 'Task' }] },
      });
    }
    return fulfillJson(route, { value: [] });
  });
  await page.addInitScript(() => {
    localStorage.setItem('rcx-workbench', JSON.stringify({
      adoBase: `${location.origin}/ado`,
      auth: 'none',
      account: 'tester',
    }));
  });
  const { pageErrors } = await bootAuthenticated(page);

  await conversation(page, 'General').click();
  const sourceMessage = page.locator('[data-message-id="general-release"]');
  await sourceMessage.hover();
  await sourceMessage.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByText('创建工作项', { exact: true }).click();

  const dialog = page.getByRole('dialog', { name: '创建工作项' });
  await expect(dialog.getByRole('button', { name: '层级工作项', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '层级工作项', exact: true }).click();
  const layout = dialog.locator('select').first();
  const expected = [
    { value: 'epic-split', label: 'Epic → Issue → 【开发】Task + 【测试】Task' },
    { value: 'epic-single', label: 'Epic → Issue → Task' },
    { value: 'feature-split', label: 'Issue → 【开发】Task + 【测试】Task' },
    { value: 'feature-single', label: 'Issue → Task' },
    { value: 'story-split', label: 'Issue → 【开发】Task + 【测试】Task' },
    { value: 'story-single', label: 'Issue → Task' },
  ];
  await expect(layout.locator('option')).toHaveCount(expected.length);
  expect(await layout.locator('option').evaluateAll((options) => options.map((option) => ({
    value: (option as HTMLOptionElement).value,
    label: option.textContent,
  })))).toEqual(expected);

  const hierarchyPreview = layout.locator('xpath=following-sibling::div[1]');
  for (const option of expected) {
    await layout.selectOption(option.value);
    await expect(hierarchyPreview).toHaveText(option.label);
  }

  await layout.selectOption('feature-split');
  const creationPreview = dialog.getByText('将创建：', { exact: true }).locator('..');
  await expect(creationPreview).toContainText('Issue：Release checklist ready');
  await expect(creationPreview).toContainText('Task：【开发】Release checklist ready');
  await expect(creationPreview).toContainText('Task：【测试】Release checklist ready');
  await dialog.screenshot({ path: testInfo.outputPath('work-item-template-325.png') });

  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(adoWrites).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('ADO 我的代码默认显示一年，并保留热力图、键盘日期明细与项目筛选（issues #298, #307, #311）', async ({ page }, testInfo) => {
  const adoRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/ado/')) adoRequests.push(request.url());
  });
  await installContributionAdoMock(page);
  await page.addInitScript(() => {
    localStorage.setItem('rcx-ui', JSON.stringify({ module: 'contributions' }));
    localStorage.setItem('rcx-workbench', JSON.stringify({
      adoBase: `${location.origin}/ado`,
      auth: 'none',
      account: 'tester',
    }));
  });
  const { pageErrors } = await bootAuthenticated(page, { expectMessages: false });
  await expect(page.getByRole('button', { name: '我的代码', exact: true })).toHaveAttribute('aria-current', 'page');
  const [rangeFrom, rangeTo] = await Promise.all([
    page.getByLabel('开始日期').inputValue(),
    page.getByLabel('结束日期').inputValue(),
  ]);
  const rangeDays = Math.round(
    (Date.parse(`${rangeTo}T12:00:00`) - Date.parse(`${rangeFrom}T12:00:00`)) / 86_400_000,
  ) + 1;
  expect(rangeDays).toBeGreaterThanOrEqual(365);
  expect(rangeDays).toBeLessThanOrEqual(366);
  await expect(page.getByRole('heading', { name: 'Test User' })).toBeVisible();
  await expect(page.getByLabel('ADO PR 总数')).toContainText('创建 PR');
  await expect(page.getByLabel('ADO PR 总数').getByText('1', { exact: true })).toBeVisible();
  await expect(page.locator('main header')).toContainText('当前范围内创建的 ADO PR');
  await expect(page.locator('main header').getByText('1', { exact: true })).toBeVisible();

  const day = page.getByRole('button', { name: /2026年8月10日，1 项贡献/ });
  await expect(day).toBeVisible();
  await day.focus();
  await expect(day).toBeFocused();
  await day.press('Enter');
  const details = page.getByRole('region', { name: /2026年8月10日.*贡献明细/ });
  await expect(details).toBeVisible();
  await expect(details.getByRole('link')).toHaveCount(1);
  await expect(details).toContainText('Improve contribution profile');

  await page.setViewportSize({ width: 1280, height: 1100 });
  await testInfo.attach('issue-291-contribution-profile', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  expect(adoRequests.filter((url) => /\/_apis\/git\/repositories|\/commits|\/threads|\/_apis\/wit\//i.test(url))).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('我的工作项默认隐藏搁置状态，并记住用户改过的筛选', async ({ page }) => {
  const workItem = {
    id: 128,
    title: 'Temporarily shelved task',
    type: 'Task',
    state: '搁置',
    priority: 2,
    project: 'RocketChatX',
    assignedTo: 'Test User',
  };
  await installAdoDirectMock(page, workItem);
  await page.addInitScript(() => {
    localStorage.setItem('rcx-workbench', JSON.stringify({
      adoBase: `${location.origin}/ado`,
      auth: 'none',
      account: 'tester',
    }));
  });
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByRole('button', { name: /我的工作项/ }).click();

  await expect(page.getByText(workItem.title, { exact: true })).toHaveCount(0);
  await expect(page.getByText('没有匹配的工作项')).toBeVisible();

  const stateSelect = page.locator('main select').first();
  await stateSelect.selectOption({ label: '全部状态' });
  await expect(page.getByText(workItem.title, { exact: true })).toBeVisible();

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('rcx-ui') ?? '{}'));
  expect(stored.workItemStateFilter).toBe('全部');

  await page.reload();
  await page.getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByRole('button', { name: /我的工作项/ }).click();
  await expect(page.locator('main select').first()).toHaveValue('全部');
  await expect(page.getByText(workItem.title, { exact: true })).toBeVisible();

  await page.evaluate(() => {
    const current = JSON.parse(localStorage.getItem('rcx-ui') ?? '{}');
    localStorage.setItem('rcx-ui', JSON.stringify({ ...current, workItemStateFilter: '活动' }));
  });
  await page.reload();
  await page.getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByRole('button', { name: /我的工作项/ }).click();
  await expect(page.locator('main select').first()).toHaveValue('活动');
  await expect(page.getByText(workItem.title, { exact: true })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('待办里的网址可以直接点击打开（issue #117）', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('rcx-todos', JSON.stringify([{
      id: 'todo-with-link',
      source: 'manual',
      note: '查看 https://example.com/work-item',
      done: false,
      createdAt: 1,
    }]));
  });
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('navigation').getByRole('button', { name: /^待办/ }).click();
  const link = page.getByRole('link', { name: 'https://example.com/work-item' });
  await expect(link).toHaveAttribute('href', 'https://example.com/work-item');
  await expect(link).toHaveAttribute('target', '_blank');
  expect(pageErrors).toEqual([]);
});

test('全局搜索能命中已加载消息', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await conversation(page, 'General').click();
  await page.keyboard.press('Control+Shift+F');
  const search = page.getByRole('dialog', { name: '全局搜索' });
  await expect(search).toBeVisible();
  await search.getByPlaceholder(/搜索会话、消息/).fill('release');
  await expect(search.getByText('Release checklist ready', { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('旧 DeepSeek 偏好下全局搜索把任务保存在 Pi 管家草稿中', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('rocketx.butler.task-provider', 'deepseek');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as Window & { __copiedText?: string }).__copiedText = value;
        },
      },
    });
  });
  const { pageErrors } = await bootAuthenticated(page);
  await activateAiRuntimeForTest(page, 'pi');
  await page.keyboard.press('Control+Shift+F');
  const search = page.getByRole('dialog', { name: '全局搜索' });
  await search.getByPlaceholder(/搜索会话、消息/).fill('检查发布风险');
  await search.getByRole('button', { name: '创建任务' }).click();

  await expect(page.getByRole('heading', { name: '在桌面端向管家交代事情' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '给管家的要求' })).toHaveValue('检查发布风险');
  expect(await page.evaluate(() => (window as Window & { __copiedText?: string }).__copiedText)).toBeUndefined();
  expect(pageErrors).toEqual([]);
});

test('会话右键菜单提供常用管理操作', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await conversation(page, 'General').click({ button: 'right' });
  await expect(page.getByRole('button', { name: '设置备注名' })).toBeVisible();
  await expect(page.getByRole('button', { name: '消息免打扰' })).toBeVisible();
  await expect(page.getByRole('button', { name: '隐藏会话' })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('Pi 管家的本地目录操作与已安排任务归在管家，不占用一级导航', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('rocketx.butler.task-provider', 'codex');
  });
  const { pageErrors } = await bootAuthenticated(page);
  await activateAiRuntimeForTest(page, 'pi');
  await expect(page.getByRole('button', { name: 'Codex', exact: true })).toHaveCount(0);
  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  await expect(page.getByRole('button', { name: '执行间', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '任务', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '在桌面端向管家交代事情' })).toBeVisible();
  await expect(page.getByRole('button', { name: '执行间', exact: true })).toHaveCount(0);
  await page.getByLabel('更多对话操作').click();
  await expect(page.getByRole('button', { name: '打开目录', exact: true })).toBeDisabled();
  const navigation = page.getByRole('navigation', { name: 'AI 协作' });
  await navigation.getByText('更多功能', { exact: true }).click();
  await navigation
    .getByRole('button', { name: '已安排', exact: true })
    .click();
  await expect(page.getByRole('region', { name: '已安排', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '使用 Codex 创建已安排任务' })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('工作项可创建绑定本地环境的原生讨论', async ({ page }, testInfo) => {
  const workItem = {
    id: 128,
    title: 'Login failure',
    type: 'Bug',
    state: 'Active',
    priority: 1,
    project: 'RocketChatX',
    assignedTo: 'Test User',
    webUrl: 'http://ado.example/RocketChatX/_workitems/edit/128',
  };
  await installAdoDirectMock(page, workItem);
  await page.addInitScript(() => {
    localStorage.setItem('rcx-workbench', JSON.stringify({
      adoBase: `${location.origin}/ado`,
      auth: 'none',
      account: 'tester',
    }));
    localStorage.setItem('rcx-agent-environments', JSON.stringify({
      version: 1,
      environments: [{
        id: 'environment-main',
        name: 'RocketChat X - 主目录',
        path: 'D:\\Repos\\rocketchatx',
        adoProjects: ['RocketChatX'],
        defaultBaseBranch: 'main',
        branchPrefix: 'ai/',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      }],
      bindings: [],
      lastEnvironmentByProject: {},
    }));
  });
  const { sentMessages, pageErrors } = await bootAuthenticated(page);
  await page.getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByRole('button', { name: /我的工作项/ }).click();
  await expect(page.getByText('Login failure', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '为工作项 #128 创建讨论' }).click();
  const dialog = page.getByRole('dialog', { name: '为 #128 创建讨论' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('本地环境')).toHaveValue('environment-main');
  await dialog.screenshot({ path: testInfo.outputPath('workitem-discussion-dialog.png') });
  await dialog.getByRole('checkbox').first().uncheck();
  await dialog.getByRole('button', { name: '创建讨论', exact: true }).click();
  await expect.poll(() => sentMessages.some((message) => message.rid === 'discussion-128')).toBe(true);
  expect(pageErrors).toEqual([]);
});

test('看板工作项可直接排给 AI，且默认不写回 ADO（issue #292）', async ({ page }, testInfo) => {
  const workItem = {
    id: 128,
    title: 'Login failure',
    type: 'Bug',
    state: 'Active',
    priority: 1,
    project: 'RocketChatX',
    assignedTo: 'Test User',
  };
  const savedQueryId = '11111111-2222-4333-8444-555555555555';
  await page.setViewportSize({ width: 1440, height: 900 });
  await installAdoDirectMock(page, workItem);
  await page.addInitScript(({ queryId }) => {
    localStorage.setItem('rcx-workbench', JSON.stringify({
      adoBase: `${location.origin}/ado`,
      auth: 'none',
      account: 'tester',
    }));
    localStorage.setItem('rcx-custom-queries', JSON.stringify([{
      id: 'query-ai-board',
      name: 'AI 托管看板',
      url: `${location.origin}/ado/RocketChatX/_queries/query/${queryId}`,
      queryId,
      project: 'RocketChatX',
    }]));
    localStorage.setItem('rcx-query-views-v1', JSON.stringify({
      'query-ai-board': 'board',
    }));
    localStorage.setItem('rcx-agent-environments', JSON.stringify({
      version: 1,
      environments: [{
        id: 'environment-main',
        name: 'RocketChat X - 主目录',
        path: 'D:\\Repos\\rocketchatx',
        adoProjects: ['RocketChatX'],
        defaultBaseBranch: 'main',
        branchPrefix: 'ai/',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      }],
      bindings: [],
      lastEnvironmentByProject: {},
    }));
  }, { queryId: savedQueryId });

  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByRole('button', { name: 'AI 托管看板', exact: true }).click();
  const card = page.getByText('Login failure', { exact: true }).locator('..').locator('..');
  await expect(card).toBeVisible();
  await card.hover();
  const assignButton = card.getByRole('button', { name: '排给 AI：工作项 #128' });
  await expect(assignButton).toBeVisible();
  await page.locator('main').screenshot({ path: testInfo.outputPath('workitem-board-ai-action.png') });

  await assignButton.click();
  const dialog = page.getByRole('dialog', { name: '为 #128 创建讨论' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('checkbox').nth(0)).toBeChecked();
  await expect(dialog.getByRole('checkbox').nth(1)).not.toBeChecked();
  await dialog.screenshot({ path: testInfo.outputPath('workitem-board-ai-dialog.png') });
  expect(pageErrors).toEqual([]);
});

test('工作项 Discussion 从会话头部进入共享 AI 托管控制面', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem('rocketx.butler.task-provider', 'deepseek');
  });
  const { pageErrors } = await bootAuthenticated(page);
  await activateAiRuntimeForTest(page, 'pi');
  await conversation(page, '#128 Login failure').click();
  const badge = page.getByLabel('打开 AI 托管控制面');
  await expect(badge).toBeVisible();
  await expect(badge).toContainText('AI 托管');
  await expect(page.getByText(/rocketx-agent/)).toHaveCount(0);
  await page.locator('main').screenshot({ path: testInfo.outputPath('agent-presence-message.png') });
  await page.locator('main > header').screenshot({ path: testInfo.outputPath('agent-presence-header.png') });
  await badge.click();
  const panel = page.locator('aside').filter({ hasText: 'AI 托管' }).last();
  await expect(panel).toBeVisible();
  await expect(panel.getByText('@alice 正在另一台设备托管')).toBeVisible();
  await expect(panel.getByRole('button', { name: '开启 AI 托管' })).toHaveCount(0);
  await panel.getByRole('button', { name: '在 AI 管家中查看' }).click();
  await expect(page.getByRole('complementary', { name: 'AI 管家导航' })).toBeVisible();
  await expect(page.getByRole('region', { name: '任务', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '在桌面端向管家交代事情' })).toBeVisible();
  await expect(page.locator('[data-session-key="room:discussion-agent"]')).toHaveAttribute('aria-current', 'page');
  expect(pageErrors).toEqual([]);
});

test('普通会话同时提供私人房间 AI 和共享托管配置', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem('rocketx.butler.task-provider', 'codex');
    localStorage.setItem('rcx-agent-environments', JSON.stringify({
      version: 1,
      environments: [{
        id: 'environment-main',
        name: 'RocketChat X - 主目录',
        path: 'D:\\Repos\\rocketchatx',
        adoProjects: [],
        defaultBaseBranch: 'main',
        branchPrefix: 'ai/',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      }],
      bindings: [],
      lastEnvironmentByProject: {},
    }));
  });
  const { pageErrors } = await bootAuthenticated(page);
  await activateAiRuntimeForTest(page, 'pi');
  await page.evaluate(async () => {
    const { useCodexWorkspace } = await import('/src/stores/codexWorkspace.ts');
    const { useAgentEnvironments } = await import('/src/stores/agentEnvironments.ts');
    useAgentEnvironments.getState().ensureEnvironment({ path: 'D:\\Repos\\another-project' });
    await useCodexWorkspace.getState().setWorkspaceRoot('D:\\Repos\\another-project');
    await useCodexWorkspace.getState().setWorkspaceRoot('D:\\Repos\\rocketchatx');
  });
  await conversation(page, 'General').click();
  await expect(page.getByRole('button', { name: '打开房间 AI', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '配置 AI 托管' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '选择 AI 托管项目' })).toHaveAttribute('title', '选择项目或打开托管设置');
  await page.getByRole('button', { name: '选择 AI 托管项目' }).click();
  await expect(page.getByRole('button', { name: /RocketChat X - 主目录（默认）/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /another-project/ })).toBeVisible();
  await page.locator('main > header').screenshot({ path: testInfo.outputPath('conversation-ai-hosting-entry.png') });
  await page.getByRole('button', { name: '在 AI 管家中管理项目…' }).click();
  await expect(page.getByLabel('项目目录').getByRole('region', { name: '项目：RocketChat X - 主目录' })).toBeVisible();
  await expect(page.getByLabel('项目目录').getByRole('region', { name: '项目：another-project' })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('首次配置 AI 托管立即打开后端和项目面板（issue #310）', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('rcx-agent-environments', JSON.stringify({
      version: 1,
      environments: [{
        id: 'environment-main',
        name: 'RocketChat X - 主目录',
        path: 'D:\\Repos\\rocketchatx',
        adoProjects: [],
        defaultBaseBranch: 'main',
        branchPrefix: 'ai/',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      }],
      bindings: [],
      lastEnvironmentByProject: {},
    }));
  });
  const { pageErrors } = await bootAuthenticated(page);
  await activateAiRuntimeForTest(page, 'pi');
  await conversation(page, 'General').click();

  await page.getByRole('button', { name: '选择 AI 托管项目' }).click();
  await page.getByRole('button', { name: /RocketChat X - 主目录/ }).click();
  await expect(page.getByText('AI 托管配置')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('新设备没有托管项目时可在托管面板直接添加', async ({ page }) => {
  await installFullTauriMock(page);
  await page.addInitScript(() => {
    (window as Window & { __dialogOpenResponses?: Array<string | string[] | null> })
      .__dialogOpenResponses = ['D:\\Repos\\rocketchatx'];
  });
  const { pageErrors } = await bootAuthenticated(page);
  await activateAiRuntimeForTest(page, 'pi');
  await conversation(page, 'General').click();

  await page.getByRole('button', { name: '配置 AI 托管' }).click();
  const panel = page.locator('aside').filter({ hasText: '在当前房间开启 AI 托管' });
  await expect(panel.getByText(/这台设备尚未添加托管项目/)).toBeVisible();
  const addProject = panel.getByRole('button', { name: '添加托管项目' });
  await expect(addProject).toBeEnabled();
  await addProject.click();

  await expect(panel.getByLabel('AI 托管项目')).toHaveValue('D:\\Repos\\rocketchatx');
  await expect(panel.getByRole('button', { name: '开启 AI 托管' })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('AI 托管开启失败时在面板内保留明确原因', async ({ page }) => {
  await installFullTauriMock(page);
  await page.addInitScript(() => {
    localStorage.setItem('rcx-agent-environments', JSON.stringify({
      version: 1,
      environments: [{
        id: 'environment-hosting-error',
        name: 'RocketX 托管项目',
        path: 'D:\\Repos\\rocketchatx',
        adoProjects: [],
        defaultBaseBranch: 'main',
        branchPrefix: 'ai/',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      }],
      bindings: [],
      lastEnvironmentByProject: {},
    }));
  });
  const { pageErrors } = await bootAuthenticated(page);
  await activateAiRuntimeForTest(page, 'pi');
  await page.evaluate(async () => {
    const [{ useCodexWorkspace }, { useSharedAgent }] = await Promise.all([
      import('/src/stores/codexWorkspace.ts'),
      import('/src/stores/sharedAgent.ts'),
    ]);
    useCodexWorkspace.setState({
      workspaceRoot: 'D:\\Repos\\rocketchatx',
      selectedModel: 'gpt-test',
      models: [{
        id: 'gpt-test',
        model: 'gpt-test',
        displayName: 'GPT Test',
        description: '测试模型',
        hidden: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        isDefault: true,
      }],
    } as never);
    useSharedAgent.setState({
      startSession: async () => {
        throw new Error('Codex 运行时启动失败，请检查本机安装');
      },
    });
  });
  await conversation(page, 'General').click();

  await page.getByRole('button', { name: '配置 AI 托管' }).click();
  const panel = page.locator('aside').filter({ hasText: '在当前房间开启 AI 托管' });
  await panel.getByRole('button', { name: '开启 AI 托管' }).click();

  await expect(panel.getByRole('alert')).toContainText('无法开启 AI 托管：Codex 运行时启动失败，请检查本机安装');
  await expect(panel.getByRole('button', { name: '开启 AI 托管' })).toBeEnabled();
  expect(pageErrors).toEqual([]);
});

test('开启 Pi 群托管时选择本次模型、推理和权限，不改管家默认值', async ({ page }, testInfo) => {
  await installFullTauriMock(page);
  await page.addInitScript(() => {
    localStorage.setItem('rocketx.butler.task-provider', 'codex');
    localStorage.setItem('rcx-agent-environments', JSON.stringify({
      version: 1,
      environments: [{
        id: 'environment-hosting',
        name: 'RocketX 托管项目',
        path: 'D:\\Repos\\rocketchatx',
        adoProjects: [],
        defaultBaseBranch: 'main',
        branchPrefix: 'ai/',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      }],
      bindings: [],
      lastEnvironmentByProject: {},
    }));
  });
  const { pageErrors } = await bootAuthenticated(page);
  await activateAiRuntimeForTest(page, 'pi');
  await page.evaluate(async () => {
    const { useCodexWorkspace } = await import('/src/stores/codexWorkspace.ts');
    useCodexWorkspace.setState({
      workspaceRoot: 'D:\\Repos\\rocketchatx',
      selectedModel: 'gpt-default',
      selectedEffort: 'medium',
      permissionPreset: 'auto',
      models: [{
        id: 'gpt-default',
        model: 'gpt-default',
        displayName: 'GPT Default',
        description: '默认模型',
        hidden: false,
        supportedReasoningEfforts: [
          { reasoningEffort: 'medium', description: '平衡' },
          { reasoningEffort: 'high', description: '深入' },
        ],
        defaultReasoningEffort: 'medium',
        isDefault: true,
      }, {
        id: 'gpt-review',
        model: 'gpt-review',
        displayName: 'GPT Review',
        description: '评审模型',
        hidden: false,
        supportedReasoningEfforts: [
          { reasoningEffort: 'high', description: '深入' },
          { reasoningEffort: 'xhigh', description: '最深入' },
        ],
        defaultReasoningEffort: 'high',
        isDefault: false,
      }],
    } as never);
  });
  await conversation(page, 'General').click();
  await page.getByRole('button', { name: '配置 AI 托管' }).click();

  const panel = page.locator('aside').filter({ hasText: '在当前房间开启 AI 托管' });
  await expect(panel).toBeVisible();
  await panel.getByLabel('AI 托管模型').selectOption('gpt-review');
  await expect(panel.getByLabel('AI 托管推理强度')).toHaveValue('high');
  await panel.getByLabel('AI 托管推理强度').selectOption('xhigh');
  await panel.getByLabel('AI 托管权限').selectOption('ask');
  await expect(panel.getByText('开启配置：gpt-review · xhigh · 询问审批', { exact: true })).toBeVisible();
  await panel.screenshot({ path: testInfo.outputPath('agent-hosting-start-config.png') });

  expect(await page.evaluate(async () => {
    const { useCodexWorkspace } = await import('/src/stores/codexWorkspace.ts');
    const state = useCodexWorkspace.getState();
    return [state.selectedModel, state.selectedEffort, state.permissionPreset];
  })).toEqual(['gpt-default', 'medium', 'auto']);
  expect(pageErrors).toEqual([]);
});

test('旧 DeepSeek 偏好迁移后可指定 Pi 群托管模型、权限和项目并启动', async ({ page }, testInfo) => {
  await installFullTauriMock(page);
  await page.addInitScript(() => localStorage.setItem('rocketx.butler.task-provider', 'deepseek'));
  const { pageErrors } = await bootAuthenticated(page);
  await page.evaluate(async () => {
    const [{ useAgentEnvironments }, { useCodexWorkspace }, { useSharedAgent }] = await Promise.all([
      import('/src/stores/agentEnvironments.ts'), import('/src/stores/codexWorkspace.ts'), import('/src/stores/sharedAgent.ts'),
    ]);
    const root = 'D:\\Repos\\rocketchatx';
    useAgentEnvironments.getState().ensureEnvironment({ path: root, name: 'RocketX 托管项目' });
    useCodexWorkspace.setState({
      workspaceRoot: root, selectedModel: 'deepseek-flash', selectedEffort: 'medium', permissionPreset: 'ask',
      models: ['deepseek-flash', 'deepseek-pro'].map((model) => ({
        id: model, model, displayName: model, description: '', hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '标准' }, { reasoningEffort: 'high', description: '深入' }],
        defaultReasoningEffort: 'medium', isDefault: model === 'deepseek-flash',
      })),
    });
    useSharedAgent.setState({
      startSession: async (rid, key, options) => {
        (window as Window & { __roomStart?: unknown }).__roomStart = { rid, key, ...options };
        return { sessionId: 'mock-room-pi' };
      },
    });
  });
  await conversation(page, 'General').click();
  await page.getByRole('button', { name: '配置 AI 托管' }).click();
  const panel = page.locator('aside').filter({ hasText: '在当前房间开启 AI 托管' });
  await expect(panel.getByText('运行时：Pi')).toBeVisible();
  await panel.getByLabel('AI 托管模型').selectOption('deepseek-pro');
  await panel.getByLabel('AI 托管推理强度').selectOption('high');
  await panel.getByLabel('AI 托管权限').selectOption('ask');
  const start = panel.getByRole('button', { name: '开启 AI 托管' });
  await expect(start).toBeInViewport();
  await panel.screenshot({ path: testInfo.outputPath('agent-hosting-pi-start-config.png') });
  await page.setViewportSize({ width: 1280, height: 520 });
  await start.scrollIntoViewIfNeeded();
  await expect(start).toBeInViewport();
  await start.click();
  await expect.poll(() => page.evaluate(() => (window as Window & { __roomStart?: unknown }).__roomStart)).toMatchObject({
    rid: 'room-general', key: 'room:room-general', workspaceRoot: 'D:\\Repos\\rocketchatx',
    runtimeModel: 'deepseek-pro', runtimeEffort: 'high', runtimePermissionPreset: 'ask',
  });
  expect(pageErrors).toEqual([]);
});

test('本机托管时点击状态入口只打开同一会话，结束需要显式操作', async ({ page }) => {
  const { pageErrors } = await installRocketChatMock(page);
  await page.addInitScript(() => {
    localStorage.setItem('rocketx.butler.task-provider', 'codex');
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '连接 Rocket.Chat', exact: true })).toBeVisible();
  await page.evaluate(async ({ server, me }) => {
    const now = Date.now();
    const deviceId = 'device-ui-local';
    localStorage.setItem('rcx-server', server);
    localStorage.setItem('rcx-auth', JSON.stringify({ authToken: 'test-token', userId: me._id }));
    localStorage.setItem('rcx-owner', `${me._id}@${server}`);
    localStorage.setItem('rcx-agent-device-id', deviceId);
    localStorage.setItem(
      `rcx-onboarding-v1:${encodeURIComponent(server)}:${me._id}`,
      JSON.stringify({
        version: 1,
        ado: 'skipped',
        checklist: {
          startedConversation: true,
          sentMessage: true,
          notificationsEnabled: true,
          dismissed: true,
        },
      }),
    );
    const session = {
      sessionId: 'session-local-room',
      serverId: server,
      ownerUserId: me._id,
      rid: 'room-general',
      tmid: 'room:room-general',
      host: {
        userId: me._id,
        deviceId,
        heartbeatAt: now,
        expiresAt: now + 90_000,
      },
      access: 'room-members',
      approvedMemberIds: [],
      status: 'ready',
      workspaceRoots: ['D:\\Repos\\rocketchatx'],
      sandboxMode: 'read-only',
      updatedAt: now,
    };
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('rocketchatx', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const key = `${encodeURIComponent(server)}:${encodeURIComponent(me._id)}:${encodeURIComponent('room:room-general')}`;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('app-data', 'readwrite');
      transaction.objectStore('app-data').put(session, ['builtin:shared-agent', key]);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, { server: SERVER, me: ME });
  await page.reload();
  await page.getByRole('navigation', { name: 'RocketX 主导航' }).getByRole('button', { name: /^消息/ }).click();
  await expect(page.getByText('General', { exact: true }).first()).toBeVisible();
  await conversation(page, 'General').click();

  const statusButton = page.getByRole('button', { name: '打开 AI 托管控制面' });
  await expect(statusButton).toBeVisible();
  await statusButton.click();
  const panel = page.locator('aside').filter({ hasText: 'AI 托管' }).last();
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: '结束' }).click();
  await expect(page.getByRole('button', { name: '配置 AI 托管' })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const { useSharedAgent } = await import('/src/stores/sharedAgent.ts');
    return useSharedAgent.getState().sessions['room:room-general']?.status;
  })).toBe('ended');
  expect(pageErrors).toEqual([]);
});

test('未连接 ADO 时工作台回到确定性的连接设置，不冒充全局今天', async ({ page }) => {
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.getByRole('complementary').getByRole('button', { name: '工作台', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('ADO 地址', { exact: true })).toBeVisible();
  await expect(page.getByText('今天确认候选版', { exact: true })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('托管项目归入管家，旧 Codex 偏好迁移至 Pi 配置与运行状态', async ({ page }, testInfo) => {
  await installFullTauriMock(page);
  await page.addInitScript(() => {
    localStorage.setItem('rocketx.butler.task-provider', 'codex');
    localStorage.setItem('rcx-agent-environments', JSON.stringify({
      version: 1,
      environments: [{
        id: 'environment-main',
        name: 'RocketChat X - 主目录',
        path: 'D:\\Repos\\rocketchatx',
        adoProjects: ['RocketChatX'],
        defaultBaseBranch: 'main',
        branchPrefix: 'ai/',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      }],
      bindings: [],
      lastEnvironmentByProject: {},
    }));
  });
  const { pageErrors } = await bootAuthenticated(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('complementary').getByRole('button', { name: 'AI', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Pi 内建通用引擎' })).toBeVisible();
  await expect(page.getByLabel('AI 托管模型', { exact: true })).toHaveCount(0);
  await expect(page.getByText('已就绪 · Pi v1.5.0 · Node 22.19.0')).toBeVisible();
  await expect(page.getByText('resources/pi-runtime', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Pi API Key')).toHaveValue('');
  await expect(page.getByLabel('Pi 默认模型')).toHaveValue('deepseek-chat');
  await page.getByRole('button', { name: '企业 / 兼容网关' }).click();
  await page.getByLabel('Pi Base URL').fill('http://gateway.example.test/v1');
  await page.getByLabel('Pi 默认模型').fill('workbench-model');
  await page.getByRole('button', { name: '仅保存配置' }).click();
  await expect(page.getByText('Pi 模型与凭据配置已保存', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重新检测', exact: true }).click();
  await expect(page.getByLabel('Pi 默认模型')).toHaveValue('workbench-model');
  await expect(page.getByLabel('Pi Base URL')).toHaveValue('http://gateway.example.test/v1');
  await page.locator('main').screenshot({ path: testInfo.outputPath('pi-runtime-settings.png') });
  await expect(page.getByText('Windows.Media.Ocr', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '本地工作区' })).not.toBeVisible();
  await expect(page.getByText('D:\\Repos\\rocketchatx', { exact: true })).not.toBeVisible();
  await expect(page.getByRole('heading', { name: '模型 Provider' })).not.toBeVisible();
  await expect(page.getByRole('heading', { name: '外部集成' })).toBeVisible();

  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  const projects = page.getByLabel('项目目录');
  await expect(projects.getByLabel('工作项目')).toBeVisible();
  await expect(projects.getByRole('region', { name: '项目：RocketChat X - 主目录' })).toBeVisible();
  await expect(page.getByRole('button', { name: '项目配置：RocketChat X - 主目录' })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('管家通过系统目录选择器添加并持久化托管项目', async ({ page }) => {
  await installFullTauriMock(page);
  await page.addInitScript(() => {
    localStorage.setItem('rocketx.butler.task-provider', 'codex');
    (window as Window & { __dialogOpenResponses?: Array<string | string[] | null> })
      .__dialogOpenResponses = ['D:\\Repos\\rocketchatx'];
  });
  const { pageErrors } = await bootAuthenticated(page);

  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  const navigation = page.getByRole('navigation', { name: 'AI 协作' });
  await navigation.getByText('更多功能', { exact: true }).click();
  await navigation.getByRole('button', { name: '添加项目目录' }).click();
  await expect(page.getByLabel('项目目录').getByRole('region', { name: '项目：rocketchatx' })).toBeVisible();

  expect(await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('rcx-agent-environments') ?? '{}');
    return stored.environments?.map((environment: { name: string; path: string; enabled: boolean }) => ({
      name: environment.name,
      path: environment.path,
      enabled: environment.enabled,
    }));
  })).toEqual([{ name: 'rocketchatx', path: 'D:\\Repos\\rocketchatx', enabled: true }]);
  expect(pageErrors).toEqual([]);
});

test('飞鸽 / IPMSG 插件可保存本机名称和 IP 范围并重新广播', async ({ page }) => {
  const pluginHtml = readFileSync('plugins/intranet-link/index.html', 'utf8');
  const bridgeBootstrap = `<script>
    window.__bridgeCalls = [];
    const bridge = new EventTarget();
    bridge.postMessage = (message) => {
      window.__bridgeCalls.push(message);
      const method = message.params?.method;
      const params = message.params?.params || {};
      let result = null;
      if (method === 'storage.get') {
        result = params.key === 'settings'
          ? { displayName: '', discoveryRanges: '192.168.20.0/30' }
          : [];
      } else if (method === 'storage.set') {
        result = { ok: true };
      } else if (method === 'native.call') {
        if (params.method === 'start') {
          result = {
            enabled: true,
            port: 2425,
            discoveryTargetCount: params.params.discoveryRanges ? 3 : 0,
          };
        } else if (params.method === 'validateDiscoveryRanges') {
          result = { count: 3 };
        } else if (params.method === 'peers') {
          result = [];
        }
      }
      queueMicrotask(() => bridge.dispatchEvent(new MessageEvent('message', {
        data: { jsonrpc: '2.0', id: message.id, result },
      })));
    };
    window.__RCX_BRIDGE__ = bridge;
  </script>`;
  await page.setContent(pluginHtml.replace('<script>', `${bridgeBootstrap}<script>`));

  await expect(page.getByLabel('本机显示名称')).toHaveValue('');
  await expect(page.getByLabel('目标 IPv4 范围')).toHaveValue('192.168.20.0/30');
  await expect(page.getByText('后台服务已启动，正在监听 UDP/TCP 2425；目标 IP 3 个。')).toBeVisible();
  await page.getByLabel('本机显示名称').fill('开发机');
  await page.getByLabel('目标 IPv4 范围').fill('10.20.30.10-10.20.30.12');
  await page.getByRole('button', { name: '保存并重新广播' }).click();
  await expect(page.getByText('后台服务已启动，正在监听 UDP/TCP 2425；目标 IP 3 个。')).toBeVisible();
  const configured = await page.evaluate(() => {
    const calls = (window as unknown as {
      __bridgeCalls: Array<{
        params?: {
          method?: string;
          params?: { key?: string; value?: unknown; method?: string; params?: unknown };
        };
      }>;
    }).__bridgeCalls;
    return {
      settings: calls.find((call) => (
        call.params?.method === 'storage.set' && call.params.params?.key === 'settings'
      ))?.params?.params?.value,
      start: calls.filter((call) => (
        call.params?.method === 'native.call' && call.params.params?.method === 'start'
      )).at(-1)?.params?.params?.params,
    };
  });
  expect(configured).toEqual({
    settings: { displayName: '开发机', discoveryRanges: '10.20.30.10-10.20.30.12' },
    start: {
      userName: '开发机',
      nickname: '开发机',
      group: 'RocketX',
      discoveryRanges: '10.20.30.10-10.20.30.12',
    },
  });
});

test('飞鸽 / IPMSG 插件在桌面发布版 CSP 下通过真实 iframe Bridge 保存范围并刷新设备', async ({ page }) => {
  const pluginHtml = readFileSync('plugins/intranet-link/index.html', 'utf8');
  const desktopSecurity = JSON.parse(readFileSync('apps/desktop/src-tauri/tauri.conf.json', 'utf8'))
    .app.security as { csp: string; dangerousDisableAssetCspModification: string[] };
  expect(desktopSecurity.dangerousDisableAssetCspModification).toContain('script-src');
  const srcDoc = sandboxDocument({
    id: 'dev.rocketx.intranet-link',
    name: '飞鸽 / IPMSG',
    version: '1.3.0',
    publisher: 'RocketX',
    runtime: 'iframe',
    entry: 'index.html',
    permissions: ['native:service', 'storage:local', 'files:read', 'ui:notify'],
    service: {
      runtime: 'native',
      command: 'rcx-plugin-intranet-link',
      platforms: ['windows'],
      protocol: 'jsonrpc-stdio',
    },
  }, pluginHtml);

  await page.setContent(`
    <meta http-equiv="Content-Security-Policy"
      content="${desktopSecurity.csp}">
    <main></main>
  `);
  await page.evaluate((html) => {
    const iframe = document.createElement('iframe');
    iframe.title = '飞鸽 / IPMSG';
    iframe.sandbox.add('allow-scripts');
    let activePort: MessagePort | undefined;
    const connect = () => {
      activePort?.close();
      const channel = new MessageChannel();
      activePort = channel.port1;
      channel.port1.addEventListener('message', (event) => {
        const request = event.data;
        const method = request.params?.method;
        const params = request.params?.params || {};
        let result = null;
        if (method === 'storage.get') {
          result = params.key === 'settings'
            ? { displayName: 'WSL 节点', discoveryRanges: '192.168.20.0/30' }
            : [];
        } else if (method === 'storage.set') {
          result = { ok: true };
        } else if (method === 'native.call') {
          if (params.method === 'start') {
            result = {
              enabled: true,
              port: 2425,
              discoveryTargetCount: params.params.discoveryRanges === '10.20.30.10-10.20.30.12' ? 3 : 2,
            };
          } else if (params.method === 'validateDiscoveryRanges') {
            result = { count: 3 };
          } else if (params.method === 'peers') {
            result = [{
              id: 'peer-1',
              user: 'tester',
              host: 'wsl-peer',
              nickname: 'WSL 测试节点',
              dialect: 'ipmsg',
              ip: '192.168.20.2',
              lastSeenMs: Date.now(),
            }];
          }
        }
        channel.port1.postMessage({ jsonrpc: '2.0', id: request.id, result });
      });
      channel.port1.start();
      iframe.contentWindow?.postMessage(
        { jsonrpc: '2.0', method: 'rcx/connect' },
        '*',
        [channel.port2],
      );
    };
    (window as typeof window & { __reconnectBridge?: () => void }).__reconnectBridge = connect;
    iframe.addEventListener('load', connect);
    document.querySelector('main')!.append(iframe);
    iframe.srcdoc = html;
  }, srcDoc);

  const app = page.frameLocator('iframe[title="飞鸽 / IPMSG"]');
  await expect(app.getByLabel('本机显示名称')).toHaveValue('WSL 节点');
  await expect(app.getByLabel('目标 IPv4 范围')).toHaveValue('192.168.20.0/30');
  await expect(app.getByText('发现 1 个联系人。')).toBeVisible();
  await page.evaluate(() => {
    (window as typeof window & { __reconnectBridge?: () => void }).__reconnectBridge?.();
  });
  await app.getByLabel('目标 IPv4 范围').fill('10.20.30.10-10.20.30.12');
  await app.getByRole('button', { name: '保存并重新广播' }).click();
  await expect(app.getByText('后台服务已启动，正在监听 UDP/TCP 2425；目标 IP 3 个。')).toBeVisible();
});
