import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectBoundaryFile, scanArchitectureBoundaries } from '../check-architecture-boundaries.mjs';

test('当前 Tauri 依赖基线没有新增越界调用', async () => {
  const reports = await scanArchitectureBoundaries();
  const violations = reports.flatMap((report) => report.violations);
  assert.deepEqual(violations, []);
  assert.ok(reports.length > 0);
});

test('新增组件级 Tauri 调用会被拒绝', () => {
  const report = inspectBoundaryFile(
    'apps/web/src/components/NewPlatformButton.tsx',
    "import { invoke } from '@tauri-apps/api/core';\nawait invoke('show_main_window');",
  );
  assert.match(report.violations[0]?.reason ?? '', /必须经过平台适配层/);
});

test('业务 Store 直接 Tauri 调用会被拒绝', () => {
  const report = inspectBoundaryFile(
    'apps/web/src/stores/chat.ts',
    "import { invoke } from '@tauri-apps/api/core';\nawait invoke('one');\nawait invoke('two');",
  );
  assert.match(report.violations[0]?.reason ?? '', /必须经过平台适配层/);
});

test('平台适配层可以直接调用 Tauri', () => {
  const report = inspectBoundaryFile(
    'apps/web/src/lib/client.ts',
    "import { invoke } from '@tauri-apps/api/core';\nawait invoke('platform_call');",
  );
  assert.deepEqual(report.violations, []);
});

test('未登记的 lib 文件不能绕过平台适配层规则', () => {
  const report = inspectBoundaryFile(
    'apps/web/src/lib/newPlatformThing.ts',
    "import { invoke } from '@tauri-apps/api/core';\nawait invoke('platform_call');",
  );
  assert.match(report.violations[0]?.reason ?? '', /必须经过平台适配层/);
});

test('Kernel 新增 chat/workbench Store 依赖会被拒绝', () => {
  const report = inspectBoundaryFile(
    'apps/web/src/kernel/runtime.tsx',
    [
      "import { useChat } from '../stores/chat';",
      "import { useWorkbench } from '../stores/workbench';",
      "import { useChatAgain } from '../stores/chat';",
    ].join('\n'),
  );
  assert.match(report.violations[0]?.reason ?? '', /Kernel.*Store.*基线/);
});

test('Kernel 动态 Store 依赖也会被拒绝', () => {
  const report = inspectBoundaryFile(
    'apps/web/src/kernel/runtime.tsx',
    "const store = await import('../stores/aiAssistant');",
  );
  assert.match(report.violations[0]?.reason ?? '', /Kernel.*Store.*基线/);
});
