import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const WEB_SOURCE_ROOT = join(REPO_ROOT, 'apps', 'web', 'src');

const DIRECT_PLATFORM_PATTERN = /@tauri-apps\//;
const DIRECT_INVOKE_PATTERN = /\binvoke\s*\(/;
const KERNEL_STORE_IMPORT_PATTERN = /(?:from|import)\s*(?:\(\s*)?['"]([^'"]*stores\/[^'"]+)['"]/;
const KERNEL_STORE_IMPORT_BASELINE = new Set();
const KERNEL_FILE = 'apps/web/src/kernel/runtime.tsx';

/**
 * These modules are the current platform/protocol adapters. Keeping the list
 * explicit prevents a generic "platform service" from becoming a new bus.
 */
const ADAPTER_FILES = new Set([
  'apps/web/src/agent/attachments.ts',
  'apps/web/src/agent/businessMcp.ts',
  'apps/web/src/agent/codexTransfer.ts',
  'apps/web/src/agent/dsh/DshController.ts',
  'apps/web/src/agent/protocol/tauriTransport.ts',
  'apps/web/src/kernel/runtime.tsx',
  'apps/web/src/lan/runtime.ts',
  'apps/web/src/lib/adoDirect.ts',
  'apps/web/src/lib/aiRuntimeBootstrap.ts',
  'apps/web/src/lib/attachmentArchiveRuntime.ts',
  'apps/web/src/lib/autostart.ts',
  'apps/web/src/lib/client.ts',
  'apps/web/src/lib/codexAutomationFiles.ts',
  'apps/web/src/lib/desktopUiScale.ts',
  'apps/web/src/lib/diagnostics.ts',
  'apps/web/src/lib/download.ts',
  'apps/web/src/lib/exportText.ts',
  'apps/web/src/lib/http.ts',
  'apps/web/src/lib/imageOcr.ts',
  'apps/web/src/lib/notify.ts',
  'apps/web/src/lib/stickerLibrary.ts',
  'apps/web/src/lib/taskbar.ts',
  'apps/web/src/lib/tray.ts',
  'apps/web/src/lib/updateSource.ts',
  'apps/web/src/lib/workspaceConfigSource.ts',
  'apps/web/src/platform/desktopCommands.ts',
  'apps/web/src/platform/desktopDialog.ts',
  'apps/web/src/platform/desktopEvents.ts',
  'apps/web/src/platform/desktopFs.ts',
  'apps/web/src/platform/desktopOpener.ts',
  'apps/web/src/platform/desktopProcess.ts',
  'apps/web/src/platform/desktopRuntime.ts',
  'apps/web/src/platform/desktopShortcut.ts',
]);

/**
 * Existing UI/store calls are grandfathered with an exact line baseline. A
 * new call in one of these files still fails; migrations can lower the count
 * without requiring a behavior change in the guard itself.
 */
const LEGACY_BASELINE = new Map([
]);

async function listSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listSourceFiles(absolute));
    } else if (/\.(?:ts|tsx)$/.test(entry.name)) {
      files.push(absolute);
    }
  }
  return files;
}

function normalizePath(value) {
  return value.split('\\').join('/');
}

function isAdapter(relativePath) {
  return ADAPTER_FILES.has(relativePath);
}

export function inspectBoundaryFile(relativePath, source) {
  const lines = source.split(/\r?\n/);
  const matches = lines
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => DIRECT_PLATFORM_PATTERN.test(line) || DIRECT_INVOKE_PATTERN.test(line));
  const kernelStoreImports = relativePath === KERNEL_FILE
    ? lines
      .map((line, index) => {
        const match = line.match(KERNEL_STORE_IMPORT_PATTERN);
        return match ? { lineNumber: index + 1, specifier: match[1] } : null;
      })
      .filter(Boolean)
    : [];
  const violations = [];

  if (matches.length > 0 && !isAdapter(relativePath)) {
    const baseline = LEGACY_BASELINE.get(relativePath);
    if (baseline === undefined) {
      violations.push({ lineNumber: matches[0].lineNumber, reason: '业务模块新增了直接 Tauri 依赖，必须经过平台适配层' });
    } else if (matches.length > baseline) {
      violations.push({
        lineNumber: matches[baseline]?.lineNumber ?? matches[0].lineNumber,
        reason: `现有例外基线为 ${baseline} 行，本次变为 ${matches.length} 行；新增调用必须迁移到适配层`,
      });
    }
  }

  if (relativePath === KERNEL_FILE && kernelStoreImports.length > KERNEL_STORE_IMPORT_BASELINE.size) {
    violations.push({
      lineNumber: kernelStoreImports[KERNEL_STORE_IMPORT_BASELINE.size].lineNumber,
      reason: `Kernel 具体 Store 依赖基线为 ${KERNEL_STORE_IMPORT_BASELINE.size} 条；新增依赖必须改为 Host/Capability 合同`,
    });
  }

  return { relativePath, matches, kernelStoreImports, violations };
}

export async function scanArchitectureBoundaries(sourceRoot = WEB_SOURCE_ROOT) {
  const absoluteFiles = await listSourceFiles(sourceRoot);
  const reports = [];
  for (const absolute of absoluteFiles) {
    const relativePath = normalizePath(relative(REPO_ROOT, absolute));
    const source = await readFile(absolute, 'utf8');
    const report = inspectBoundaryFile(relativePath, source);
    if (report.matches.length > 0 || report.kernelStoreImports.length > 0) reports.push(report);
  }
  return reports;
}

async function main() {
  const reports = await scanArchitectureBoundaries();
  const violations = reports.flatMap((report) => report.violations.map((violation) => ({
    ...violation,
    file: report.relativePath,
  })));
  const legacyCount = reports.filter((report) => LEGACY_BASELINE.has(report.relativePath)).length;
  if (violations.length > 0) {
    console.error('[architecture] boundary violations:');
    for (const violation of violations) {
      console.error(`- ${violation.file}:${violation.lineNumber} ${violation.reason}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`[architecture] scanned ${reports.length} Tauri-touching files; ${legacyCount} legacy exceptions unchanged`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
