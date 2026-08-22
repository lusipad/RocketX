import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  getAiRuntimeStartupResolution,
  initializeStartupAiRuntimeProvider,
} from '../../apps/web/src/lib/aiRuntimeBootstrap';
import {
  AI_RUNTIME_PROVIDER_STORAGE_KEY,
  getAiRuntimeProvider,
  normalizeAiRuntimeProvider,
  persistAiRuntimeProvider,
  readConfiguredAiRuntimeProvider,
  readAiRuntimeProvider,
  resetAiRuntimeProviderForTests,
  runtimeFeatures,
  selectStartupAiRuntimeProvider,
} from '../../apps/web/src/lib/runtimeMode';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test('AI 运行时只接受 Codex、DSH、无 AI，并保持旧版默认值', () => {
  const storage = new MemoryStorage();
  assert.equal(normalizeAiRuntimeProvider('codex'), 'codex');
  assert.equal(normalizeAiRuntimeProvider('deepseek'), 'deepseek');
  assert.equal(normalizeAiRuntimeProvider('none'), 'none');
  assert.equal(normalizeAiRuntimeProvider('unknown'), 'deepseek');
  assert.equal(readAiRuntimeProvider(storage), 'deepseek');

  storage.setItem(AI_RUNTIME_PROVIDER_STORAGE_KEY, 'codex');
  assert.equal(readAiRuntimeProvider(storage), 'codex');
  storage.setItem(AI_RUNTIME_PROVIDER_STORAGE_KEY, 'none');
  assert.equal(readAiRuntimeProvider(storage), 'none');
});

test('精简包首次启动按本机运行时自动启用 AI，二者都有时优先 DSH', () => {
  const storage = new MemoryStorage();
  assert.equal(readConfiguredAiRuntimeProvider(storage), undefined);
  assert.equal(selectStartupAiRuntimeProvider(undefined, { deepseek: true, codex: true }), 'deepseek');
  assert.equal(selectStartupAiRuntimeProvider(undefined, { deepseek: true, codex: false }), 'deepseek');
  assert.equal(selectStartupAiRuntimeProvider(undefined, { deepseek: false, codex: true }), 'codex');
  assert.equal(selectStartupAiRuntimeProvider(undefined, { deepseek: false, codex: false }), 'none');

  storage.setItem(AI_RUNTIME_PROVIDER_STORAGE_KEY, 'codex');
  assert.equal(readConfiguredAiRuntimeProvider(storage), 'codex');
  assert.equal(selectStartupAiRuntimeProvider('codex', { deepseek: true, codex: true }), 'codex');
  assert.equal(selectStartupAiRuntimeProvider('codex', { deepseek: true, codex: false }), 'none');
  assert.equal(selectStartupAiRuntimeProvider('deepseek', { deepseek: false, codex: true }), 'none');
  assert.equal(selectStartupAiRuntimeProvider('none', { deepseek: true, codex: true }), 'none');
});

test('slim 首次启动并行探测 DSH 与 Codex，应用自动选择但不写成用户偏好', async () => {
  const storage = new MemoryStorage();
  const calls: string[] = [];
  try {
    const selected = await initializeStartupAiRuntimeProvider({
      desktop: true,
      storage,
      invokeRuntime: async <T>(command: string) => {
        calls.push(command);
        if (command === 'desktop_distribution_profile') return 'slim' as T;
        return { ready: true } as T;
      },
    });

    assert.equal(selected, 'deepseek');
    assert.deepEqual(calls.sort(), [
      'codex_runtime_probe',
      'desktop_distribution_profile',
      'dsh_runtime_probe',
    ]);
    assert.equal(storage.getItem(AI_RUNTIME_PROVIDER_STORAGE_KEY), null);
    assert.equal(getAiRuntimeProvider(), 'deepseek');
  } finally {
    resetAiRuntimeProviderForTests(readAiRuntimeProvider());
  }
});

test('web 进程固定禁用 AI，但保留下次桌面启动偏好', async () => {
  const storage = new MemoryStorage();
  const calls: string[] = [];
  storage.setItem(AI_RUNTIME_PROVIDER_STORAGE_KEY, 'codex');
  try {
    const selected = await initializeStartupAiRuntimeProvider({
      desktop: false,
      storage,
      invokeRuntime: async <T>(command: string) => {
        calls.push(command);
        throw new Error(`unexpected command: ${command}`);
      },
    });

    assert.equal(selected, 'none');
    assert.deepEqual(calls, []);
    assert.deepEqual(getAiRuntimeStartupResolution(), {
      active: 'none',
      configured: 'codex',
      profile: 'web',
      source: 'web',
    });
  } finally {
    resetAiRuntimeProviderForTests(readAiRuntimeProvider());
  }
});

test('full 首次启动先验证内置 DSH；成功时保持完整包默认值', async () => {
  const storage = new MemoryStorage();
  const calls: string[] = [];
  try {
    assert.equal(await initializeStartupAiRuntimeProvider({
      desktop: true,
      storage,
      invokeRuntime: async <T>(command: string) => {
        calls.push(command);
        if (command === 'desktop_distribution_profile') return 'full' as T;
        return { ready: true } as T;
      },
    }), 'deepseek');
    // full 路径的两个运行时探测并行发起（性能要求），DSH 就绪时优先保持完整包默认值
    assert.deepEqual(calls[0], 'desktop_distribution_profile');
    assert.ok(calls.includes('dsh_runtime_probe'));
    assert.deepEqual(getAiRuntimeStartupResolution(), {
      active: 'deepseek',
      profile: 'full',
      source: 'full-default',
    });
  } finally {
    resetAiRuntimeProviderForTests(readAiRuntimeProvider());
  }
});

test('full 包内置 DSH 损坏时回退探测 Codex，并按真实可用性启动', async () => {
  const storage = new MemoryStorage();
  const calls: string[] = [];
  try {
    assert.equal(await initializeStartupAiRuntimeProvider({
      desktop: true,
      storage,
      invokeRuntime: async <T>(command: string) => {
        calls.push(command);
        if (command === 'desktop_distribution_profile') return 'full' as T;
        if (command === 'dsh_runtime_probe') return { ready: false, reason: 'DSH child exited' } as T;
        if (command === 'codex_runtime_probe') return { ready: true } as T;
        throw new Error(`unexpected command: ${command}`);
      },
    }), 'codex');
    assert.deepEqual(calls, [
      'desktop_distribution_profile',
      'dsh_runtime_probe',
      'codex_runtime_probe',
    ]);
    assert.deepEqual(getAiRuntimeStartupResolution(), {
      active: 'codex',
      profile: 'full',
      reason: 'DSH child exited',
      source: 'automatic',
    });
  } finally {
    resetAiRuntimeProviderForTests(readAiRuntimeProvider());
  }
});

test('安装形态标记缺失时按 slim 安全路径探测实际运行时', async () => {
  const storage = new MemoryStorage();
  const calls: string[] = [];
  try {
    const selected = await initializeStartupAiRuntimeProvider({
      desktop: true,
      storage,
      invokeRuntime: async <T>(command: string) => {
        calls.push(command);
        if (command === 'desktop_distribution_profile') return 'unknown' as T;
        return { ready: command === 'codex_runtime_probe' } as T;
      },
    });

    assert.equal(selected, 'codex');
    assert.deepEqual(calls.sort(), [
      'codex_runtime_probe',
      'desktop_distribution_profile',
      'dsh_runtime_probe',
    ]);
    assert.equal(getAiRuntimeStartupResolution().profile, 'unknown');
  } finally {
    resetAiRuntimeProviderForTests(readAiRuntimeProvider());
  }
});

test('显式无 AI 不执行安装形态或运行时探测', async () => {
  const storage = new MemoryStorage();
  const calls: string[] = [];
  storage.setItem(AI_RUNTIME_PROVIDER_STORAGE_KEY, 'none');
  try {
    assert.equal(await initializeStartupAiRuntimeProvider({
      desktop: true,
      storage,
      invokeRuntime: async <T>(command: string) => {
        calls.push(command);
        throw new Error(`unexpected command: ${command}`);
      },
    }), 'none');
    assert.deepEqual(calls, []);
  } finally {
    resetAiRuntimeProviderForTests(readAiRuntimeProvider());
  }
});

test('显式选择只探测所选运行时；不可用时不换脑并以无 AI 安全启动', async () => {
  const storage = new MemoryStorage();
  const calls: string[] = [];
  try {
    storage.setItem(AI_RUNTIME_PROVIDER_STORAGE_KEY, 'codex');
    assert.equal(await initializeStartupAiRuntimeProvider({
      desktop: true,
      storage,
      invokeRuntime: async <T>(command: string) => {
        calls.push(command);
        return { ready: false, reason: 'Codex 未登录' } as T;
      },
    }), 'none');
    assert.deepEqual(calls, ['codex_runtime_probe']);
    assert.deepEqual(getAiRuntimeStartupResolution(), {
      active: 'none',
      configured: 'codex',
      profile: 'unknown',
      reason: 'Codex 未登录',
      source: 'explicit-unavailable',
    });
    assert.equal(storage.getItem(AI_RUNTIME_PROVIDER_STORAGE_KEY), 'codex');
  } finally {
    resetAiRuntimeProviderForTests(readAiRuntimeProvider());
  }
});

test('启动探测不阻塞首屏，在内核初始化前完成，并由桌面端提供只读 DSH 可用性命令', () => {
  const bootstrap = readFileSync('apps/web/src/main.tsx', 'utf8');
  const settings = readFileSync('apps/web/src/components/AiSettings.tsx', 'utf8');
  const desktop = readFileSync('apps/desktop/src-tauri/src/main.rs', 'utf8');
  const dsh = readFileSync('apps/desktop/src-tauri/src/dsh.rs', 'utf8');
  const startup = readFileSync('apps/web/src/lib/startup.ts', 'utf8');
  const desktopConfig = readFileSync('apps/desktop/src-tauri/tauri.conf.json', 'utf8');
  const slimInstaller = readFileSync('apps/desktop/src-tauri/windows/slim-installer-hooks.nsh', 'utf8');
  const fullInstaller = readFileSync('apps/desktop/src-tauri/windows/full-installer-hooks.nsh', 'utf8');

  // 顺序锁定：探测发起 → 启动协调器（只发起、不等待）→ 首屏渲染 → 等待协调器；
  // 协调器内部再应用探测结果并初始化内核。
  // 渲染不等待探测（full 版探测含归档校验与进程 spawn，是启动卡顿根因）；
  // 内核等待探测结果，因为例行任务调度依赖最终 provider。
  const selection = bootstrap.indexOf('initializeStartupAiRuntimeProvider({');
  const render = bootstrap.indexOf('ReactDOM.createRoot');
  const coordinator = bootstrap.indexOf('startupCoordinator ??= createCoordinator');
  const start = bootstrap.indexOf('const startupPromise = startupCoordinator.start()');
  const awaitStart = bootstrap.indexOf('await startupPromise');
  const apply = startup.indexOf('await withTimeout((signal) => steps.initializeRuntime(signal)');
  const kernel = startup.indexOf('await withTimeout((signal) => steps.initializeKernel(signal)');
  assert.ok(selection >= 0 && selection < coordinator && coordinator < start && start < render && render < awaitStart);
  assert.ok(apply >= 0 && apply < kernel);
  assert.match(bootstrap, /useUI\.setState\(\{ aiRuntimeProvider/);
  assert.match(settings, /readConfiguredAiRuntimeProvider\(\) \?\? getAiRuntimeProvider\(\)/);
  assert.match(settings, /选择已保留.*本次未启用/s);
  // 探测命令必须离开主线程（async + spawn_blocking），否则探测期间窗口事件循环冻结
  assert.match(dsh, /pub async fn dsh_runtime_probe/);
  assert.match(dsh, /spawn_blocking/);
  assert.match(desktop, /dsh::dsh_runtime_probe/);
  assert.match(desktop, /desktop_distribution_profile/);
  assert.match(desktop, /desktop_distribution_profile[\s\S]*executable_is_local_build/);
  assert.match(desktopConfig, /slim-installer-hooks\.nsh/);
  assert.match(slimInstaller, /RMDir \/r "\$LOCALAPPDATA\\RocketX\\resources"/);
  assert.match(slimInstaller, /rocketx-package-profile/);
  assert.match(slimInstaller, /FileWrite \$0 "slim"/);
  assert.match(slimInstaller, /MB_ICONEXCLAMATION.*自动检测本机 AI 运行时/);
  assert.match(slimInstaller, /Goto slim_profile_installed/);
  assert.match(fullInstaller, /rocketx-package-profile/);
  assert.match(fullInstaller, /FileWrite \$1 "full"/);
  assert.match(fullInstaller, /MB_ICONEXCLAMATION.*自动检测内置 AI 运行时/);
  assert.match(fullInstaller, /Goto full_profile_installed/);
});

test('修改 AI 运行时只持久化下次启动值，不热切换当前进程', () => {
  const storage = new MemoryStorage();
  const activeAtStartup = getAiRuntimeProvider();
  persistAiRuntimeProvider(activeAtStartup === 'none' ? 'codex' : 'none', storage);

  assert.notEqual(readAiRuntimeProvider(storage), activeAtStartup);
  assert.equal(getAiRuntimeProvider(), activeAtStartup);
});

test('功能矩阵保证同一进程只启用所选 AI 后端', () => {
  const codex = runtimeFeatures('standard', 'codex');
  assert.equal(codex.ai, true);
  assert.equal(codex.butler, true);
  assert.equal(codex.sharedAgent, true);
  assert.equal(codex.routines, true);
  assert.equal(codex.runtimeProbes, true);

  const dsh = runtimeFeatures('standard', 'deepseek');
  assert.equal(dsh.ai, true);
  assert.equal(dsh.butler, true);
  assert.equal(dsh.sharedAgent, true);
  assert.equal(dsh.routines, false);
  assert.equal(dsh.runtimeProbes, false);

  const none = runtimeFeatures('standard', 'none');
  assert.equal(none.ai, false);
  assert.equal(none.butler, true);
  assert.equal(none.sharedAgent, true);
  assert.equal(none.routines, false);
  assert.equal(none.runtimeProbes, false);
  assert.equal(none.ocr, false);
});

test('界面只在设置页选择下次启动的 AI，任务页和房间不再提供热切换', () => {
  const settings = readFileSync('apps/web/src/components/AiSettings.tsx', 'utf8');
  const page = readFileSync('apps/web/src/pages/ButlerPage.tsx', 'utf8');
  const rail = readFileSync('apps/web/src/components/NavRail.tsx', 'utf8');
  const room = readFileSync('apps/web/src/components/ButlerPanel.tsx', 'utf8');
  const hosting = readFileSync('apps/web/src/components/AgentPanel.tsx', 'utf8');

  assert.match(settings, /Codex.*DSH.*无 AI/s);
  assert.match(settings, /重启.*生效/);
  assert.match(settings, /persistAiRuntimeProvider/);
  assert.doesNotMatch(page, /setButlerTaskProvider|管家执行引擎/);
  assert.doesNotMatch(rail, /setButlerTaskProvider|管家执行引擎/);
  assert.doesNotMatch(room, /switchProvider|房间 AI 执行引擎/);
  assert.doesNotMatch(hosting, /setSelectedBackend|托管后端/);
});
