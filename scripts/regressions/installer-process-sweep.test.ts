import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// 升级/卸载时，上游 Tauri NSIS 模板的 CheckIfAppIsRunning 只按映像名查杀一次并
// 等待 500ms。进程退出慢、或 full 私有运行时（$INSTDIR\resources\node 下的
// node.exe 等异名进程）占用安装目录时，卸载器 Delete/Rename 静默失败，外层安装器
// 随即报 unableToUninstall（用户从 v0.43.2 升级时命中）。两个 hooks 文件因此必须
// 在 PREINSTALL / PREUNINSTALL 中先按可执行路径清扫 $INSTDIR 进程并等待锁释放。
test('Windows 安装器在卸载/安装前按可执行路径清扫安装目录进程', async () => {
  const [slimHooks, fullHooks, slimConfig, fullConfig] = await Promise.all([
    readFile('apps/desktop/src-tauri/windows/slim-installer-hooks.nsh', 'utf8'),
    readFile('apps/desktop/src-tauri/windows/full-installer-hooks.nsh', 'utf8'),
    readFile('apps/desktop/src-tauri/tauri.conf.json', 'utf8'),
    readFile('apps/desktop/src-tauri/tauri.full.conf.json', 'utf8'),
  ]);

  for (const [name, hooks] of [
    ['slim', slimHooks],
    ['full', fullHooks],
  ] as const) {
    // 两个 hook 入口都必须插入清扫宏，抢在模板 CheckIfAppIsRunning 之前运行。
    assert.match(hooks, /!macro NSIS_HOOK_PREINSTALL\r?\n\s+!insertmacro ROCKETX_SWEEP_INSTDIR_PROCESSES/, name);
    assert.match(hooks, /!macro NSIS_HOOK_PREUNINSTALL\r?\n\s+!insertmacro ROCKETX_SWEEP_INSTDIR_PROCESSES/, name);

    // 先按映像名结束 rocketx.exe（currentUser 安装用当前用户口径，幂等）。
    assert.match(hooks, /nsis_tauri_utils::KillProcessCurrentUser "rocketx\.exe"/, name);

    // 再按可执行路径清扫 $INSTDIR 下的所有进程并轮询等待退出（最多 10 秒），
    // 兜住异名进程（如 full 私有 node.exe）锁住安装目录的场景。
    assert.match(hooks, /Win32_Process/, name);
    assert.match(hooks, /ExecutablePath\.StartsWith\(\$\$d, \[System\.StringComparison\]::OrdinalIgnoreCase\)/, name);
    assert.match(hooks, /Stop-Process -Id \$\$_\.ProcessId -Force/, name);
    assert.match(hooks, /AddSeconds\(10\)/, name);

    // 清扫失败只允许记录日志，绝不能 Abort——最终由模板自身的查杀与报错兜底。
    const sweepBody = hooks.match(
      /!macro ROCKETX_SWEEP_INSTDIR_PROCESSES([\s\S]*?)!macroend/,
    );
    assert.ok(sweepBody, name);
    assert.doesNotMatch(sweepBody[1], /\bAbort\b/, name);
  }

  // 两个 hooks 文件中的清扫宏必须逐字保持一致（无公共 include，靠本测试防腐烂）。
  const slimSweep = slimHooks.match(/!macro ROCKETX_SWEEP_INSTDIR_PROCESSES[\s\S]*?!macroend/)?.[0];
  const fullSweep = fullHooks.match(/!macro ROCKETX_SWEEP_INSTDIR_PROCESSES[\s\S]*?!macroend/)?.[0];
  assert.ok(slimSweep && fullSweep);
  assert.equal(slimSweep, fullSweep);

  // 两套配置仍各自指向对应的 hooks 文件。
  assert.match(slimConfig, /"\.\/windows\/slim-installer-hooks\.nsh"/);
  assert.match(fullConfig, /"\.\/windows\/full-installer-hooks\.nsh"/);
});
