import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const WEB_SOURCE_ROOT = join(REPO_ROOT, 'apps', 'web', 'src');
const RUST_SOURCE_ROOT = join(REPO_ROOT, 'apps', 'desktop', 'src-tauri', 'src');

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
  'apps/web/src/lib/prefsCache.ts',
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
  'apps/web/src/platform/localVoice.ts',
]);

/**
 * Existing UI/store calls are grandfathered with an exact line baseline. A
 * new call in one of these files still fails; migrations can lower the count
 * without requiring a behavior change in the guard itself.
 */
const LEGACY_BASELINE = new Map([
]);

async function listSourceFiles(directory, extensionPattern = /\.(?:ts|tsx)$/) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listSourceFiles(absolute, extensionPattern));
    } else if (extensionPattern.test(entry.name)) {
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

function resolveRelativeWebImport(sourceRoot, fromAbsoluteFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromAbsoluteFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return normalizePath(relative(sourceRoot, candidate));
    }
  }
  return null;
}

function isTypeOnlyNamedClause(clause) {
  if (!clause.startsWith('{') || !clause.endsWith('}')) return false;
  const inner = clause.slice(1, -1).split(',').map((item) => item.trim()).filter(Boolean);
  return inner.length > 0 && inner.every((item) => item.startsWith('type '));
}

function extractModuleImports(sourceRoot, absoluteFile, source) {
  const selfRel = normalizePath(relative(sourceRoot, absoluteFile));
  const staticRuntimeTargets = new Set();
  const dynamicTargets = new Set();

  const staticImportRe = /^\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?/gm;
  for (const match of source.matchAll(staticImportRe)) {
    const clause = match[1].trim();
    if (clause.startsWith('type ') || clause.startsWith('type{') || isTypeOnlyNamedClause(clause)) continue;
    const target = resolveRelativeWebImport(sourceRoot, absoluteFile, match[2]);
    if (target && target !== selfRel) staticRuntimeTargets.add(target);
  }

  for (const match of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) {
    const target = resolveRelativeWebImport(sourceRoot, absoluteFile, match[1]);
    if (target && target !== selfRel) staticRuntimeTargets.add(target);
  }

  for (const match of source.matchAll(/^\s*export\s+(?!type\s)([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm)) {
    const clause = match[1].trim();
    if (isTypeOnlyNamedClause(clause)) continue;
    const target = resolveRelativeWebImport(sourceRoot, absoluteFile, match[2]);
    if (target && target !== selfRel) staticRuntimeTargets.add(target);
  }

  for (const match of source.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const target = resolveRelativeWebImport(sourceRoot, absoluteFile, match[1]);
    if (target && target !== selfRel) dynamicTargets.add(target);
  }

  return { staticRuntimeTargets: [...staticRuntimeTargets], dynamicTargets: [...dynamicTargets] };
}

function findStrongComponents(nodes, getNeighbors) {
  let nextIndex = 0;
  const indices = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];

  function strongConnect(node) {
    indices.set(node, nextIndex);
    lowlink.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const neighbor of getNeighbors(node)) {
      if (!nodes.has(neighbor)) continue;
      if (!indices.has(neighbor)) {
        strongConnect(neighbor);
        lowlink.set(node, Math.min(lowlink.get(node), lowlink.get(neighbor)));
      } else if (onStack.has(neighbor)) {
        lowlink.set(node, Math.min(lowlink.get(node), indices.get(neighbor)));
      }
    }

    if (lowlink.get(node) === indices.get(node)) {
      const component = [];
      for (;;) {
        const w = stack.pop();
        onStack.delete(w);
        component.push(w);
        if (w === node) break;
      }
      if (component.length > 1) {
        components.push(component.sort());
      }
    }
  }

  for (const node of [...nodes].sort()) {
    if (!indices.has(node)) strongConnect(node);
  }
  return components;
}

const DSM_FORBIDDEN_RULES = [
  {
    layer: 'DP1 平台与运行时基座',
    files: new Set([
      'lib/http.ts',
      'lib/serverEndpoint.ts',
      'lib/runtimeLifecycle.ts',
      'lib/runtimeMode.ts',
      'lib/startup.ts',
      'lib/desktopConfigBackup.ts',
      'lib/externalContinuation.ts',
      'stores/ui.ts',
      'stores/toast.ts',
    ]),
    forbidPrefixes: ['lan/', 'kernel/', 'agent/'],
    forbidExact: new Set(['stores/auth.ts', 'stores/chat.ts', 'stores/workbench.ts', 'lib/client.ts']),
  },
  {
    layer: 'DP2 多账号隔离与本地契约',
    files: new Set(['lib/accountScope.ts', 'lib/localDataContract.ts', 'platform/butlerAccountReady.ts']),
    forbidPrefixes: ['stores/', 'lan/', 'kernel/', 'agent/'],
    forbidExact: new Set(['lib/client.ts']),
  },
  {
    layer: 'DP3 本地多模态感知',
    files: new Set(['lib/imageOcr.ts', 'platform/localVoice.ts', 'stores/localVoice.ts']),
    forbidPrefixes: ['lan/', 'kernel/', 'agent/'],
    forbidExact: new Set([
      'stores/todos.ts',
      'stores/calendar.ts',
      'stores/focus.ts',
      'stores/workbench.ts',
      'stores/auth.ts',
      'stores/chat.ts',
      'lib/client.ts',
    ]),
  },
  {
    layer: 'DP4 本地个人生产力',
    files: new Set(['stores/todos.ts', 'stores/calendar.ts', 'stores/focus.ts', 'stores/downloadHistory.ts']),
    forbidPrefixes: ['lan/', 'kernel/', 'agent/'],
    forbidExact: new Set(['stores/auth.ts', 'stores/chat.ts', 'stores/workbench.ts', 'lib/client.ts']),
  },
  {
    layer: 'DP5 工作台存储',
    files: new Set(['stores/workbench.ts']),
    forbidPrefixes: ['lan/', 'kernel/', 'agent/'],
    forbidExact: new Set(['stores/chat.ts', 'stores/auth.ts']),
  },
  {
    layer: 'DP5 局域网 P2P 传输层',
    matchPrefix: 'lan/',
    forbidPrefixes: ['stores/', 'kernel/', 'agent/'],
    forbidExact: new Set(['lib/client.ts']),
  },
  {
    layer: 'DP6 认证会话门控',
    files: new Set(['stores/auth.ts']),
    forbidPrefixes: ['lan/', 'kernel/', 'agent/'],
    forbidExact: new Set(['stores/codexWorkspace.ts', 'stores/sharedAgent.ts']),
  },
  {
    layer: 'DP8 微内核视图壳',
    files: new Set(['kernel/AppFrame.tsx']),
    forbidPrefixes: ['stores/'],
    forbidExact: new Set(['kernel/runtime.tsx']),
  },
  {
    layer: 'DP9 AI 运行时协议底座',
    files: new Set([
      'agent/dynamicToolRegistry.ts',
      'agent/AppServerController.ts',
      'agent/businessMcp.ts',
      'agent/acp/acpHostBridge.ts',
      'stores/acpAgents.ts',
    ]),
    forbidPrefixes: [],
    forbidExact: new Set([
      'agent/codexHostTools.ts',
      'stores/workLedger.ts',
      'stores/butlerMemory.ts',
      'stores/butlerCognition.ts',
      'stores/codexWorkspace.ts',
      'stores/routines.ts',
      'stores/sharedAgent.ts',
    ]),
  },
];

function matchesForbiddenTarget(rule, target) {
  if (rule.forbidExact?.has(target)) return true;
  return (rule.forbidPrefixes ?? []).some((prefix) => target.startsWith(prefix));
}

function findMatchingDelimEnd(source, openIndex, openChar, closeChar) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === openChar) depth += 1;
    else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return source.length - 1;
}

function stripSpawnBlockingCalls(body) {
  let result = '';
  let cursor = 0;
  const marker = 'spawn_blocking';
  while (cursor < body.length) {
    const hit = body.indexOf(marker, cursor);
    if (hit < 0) {
      result += body.slice(cursor);
      break;
    }
    const prevCh = hit > 0 ? body[hit - 1] : ' ';
    if (/[a-zA-Z0-9_]/.test(prevCh)) {
      result += body.slice(cursor, hit + marker.length);
      cursor = hit + marker.length;
      continue;
    }
    const afterMarker = body.slice(hit + marker.length).match(/^\s*\(/);
    if (!afterMarker) {
      result += body.slice(cursor, hit + marker.length);
      cursor = hit + marker.length;
      continue;
    }
    const openParen = hit + marker.length + afterMarker[0].length - 1;
    const closeParen = findMatchingDelimEnd(body, openParen, '(', ')');
    result += body.slice(cursor, hit);
    result += 'spawn_blocking(<offloaded>)';
    cursor = closeParen + 1;
  }
  return result;
}

export async function scanRustAsyncCommandBlocking(rustRoot = RUST_SOURCE_ROOT) {
  const violations = [];
  if (!existsSync(rustRoot)) return violations;
  const rustFiles = (await listSourceFiles(rustRoot, /\.rs$/)).sort();
  const cmdRegex = /#\[tauri::command\][\s\S]{0,200}?\bpub\s+async\s+fn\s+([a-zA-Z0-9_]+)\s*\(/g;

  for (const absPath of rustFiles) {
    const raw = await readFile(absPath, 'utf8');
    const prodCode = raw.split(/#\[cfg\(test\)\]/)[0];
    let match;
    while ((match = cmdRegex.exec(prodCode)) !== null) {
      const fnName = match[1];
      const sigParenStart = prodCode.indexOf('(', match.index + match[0].length - 1);
      if (sigParenStart < 0) continue;
      const sigParenEnd = findMatchingDelimEnd(prodCode, sigParenStart, '(', ')');
      const braceStart = prodCode.indexOf('{', sigParenEnd);
      if (braceStart < 0) continue;
      const braceEnd = findMatchingDelimEnd(prodCode, braceStart, '{', '}');
      const body = prodCode.slice(braceStart, braceEnd + 1);
      const withoutSpawnBlocking = stripSpawnBlockingCalls(body);
      if (/\bstd::thread::sleep\s*\(/.test(withoutSpawnBlocking)) {
        violations.push({
          file: normalizePath(relative(REPO_ROOT, absPath)),
          target: `async command ${fnName}`,
          layer: 'Rust DP2/DP4 异步执行底座',
          reason: `#[tauri::command] async fn ${fnName} 不得在 Tokio async 上下文中直接调用 std::thread::sleep(`,
        });
      }
    }
  }
  return violations;
}

export async function scanAxiomaticDesignMatrix(
  sourceRoot = WEB_SOURCE_ROOT,
  rustRoot = RUST_SOURCE_ROOT,
) {
  const absoluteFiles = await listSourceFiles(sourceRoot);
  const staticAdj = new Map();
  const combinedAdj = new Map();
  const dsmViolations = [];

  for (const absolute of absoluteFiles) {
    const rel = normalizePath(relative(sourceRoot, absolute));
    const source = await readFile(absolute, 'utf8');
    const { staticRuntimeTargets, dynamicTargets } = extractModuleImports(sourceRoot, absolute, source);
    staticAdj.set(rel, staticRuntimeTargets);
    combinedAdj.set(rel, [...new Set([...staticRuntimeTargets, ...dynamicTargets])]);

    for (const rule of DSM_FORBIDDEN_RULES) {
      const matched = rule.files?.has(rel) || (rule.matchPrefix && rel.startsWith(rule.matchPrefix));
      if (!matched) continue;
      for (const target of [...staticRuntimeTargets, ...dynamicTargets]) {
        if (matchesForbiddenTarget(rule, target)) {
          dsmViolations.push({
            file: `apps/web/src/${rel}`,
            target: `apps/web/src/${target}`,
            layer: rule.layer,
            reason: `${rule.layer} 不得出现上三角反向依赖 (${rel} -> ${target})`,
          });
        }
      }
    }
  }

  const allWebNodes = new Set(staticAdj.keys());
  const runtimeStaticCycles = findStrongComponents(allWebNodes, (node) => staticAdj.get(node) ?? []);

  const storeNodes = new Set([...combinedAdj.keys()].filter((node) => node.startsWith('stores/')));
  const storeCycles = findStrongComponents(storeNodes, (node) =>
    (combinedAdj.get(node) ?? []).filter((target) => storeNodes.has(target)),
  );

  const githubConnectorPath = join(rustRoot, 'github_connector.rs');
  if (existsSync(githubConnectorPath)) {
    const githubSource = await readFile(githubConnectorPath, 'utf8');
    if (/\bcrate::butler_worktree\b/.test(githubSource)) {
      dsmViolations.push({
        file: 'apps/desktop/src-tauri/src/github_connector.rs',
        target: 'apps/desktop/src-tauri/src/butler_worktree.rs',
        layer: 'Rust DP5 连接器',
        reason: 'github_connector.rs 不得反向依赖 butler_worktree（应通过 native::git_remote 解耦）',
      });
    }
  }

  const rustBlockingViolations = await scanRustAsyncCommandBlocking(rustRoot);
  dsmViolations.push(...rustBlockingViolations);

  return {
    runtimeStaticCycles,
    storeCycles,
    dsmViolations,
  };
}

async function main() {
  const reports = await scanArchitectureBoundaries();
  const boundaryViolations = reports.flatMap((report) => report.violations.map((violation) => ({
    ...violation,
    file: report.relativePath,
  })));
  const dsm = await scanAxiomaticDesignMatrix();
  const legacyCount = reports.filter((report) => LEGACY_BASELINE.has(report.relativePath)).length;

  const hasDsmFailure =
    dsm.runtimeStaticCycles.length > 0 ||
    dsm.storeCycles.length > 0 ||
    dsm.dsmViolations.length > 0;

  if (boundaryViolations.length > 0 || hasDsmFailure) {
    if (boundaryViolations.length > 0) {
      console.error('[architecture] boundary violations:');
      for (const violation of boundaryViolations) {
        console.error(`- ${violation.file}:${violation.lineNumber} ${violation.reason}`);
      }
    }
    if (dsm.runtimeStaticCycles.length > 0) {
      console.error('[architecture] runtime static import cycles:');
      for (const cycle of dsm.runtimeStaticCycles) {
        console.error(`- ${cycle.join(' <-> ')}`);
      }
    }
    if (dsm.storeCycles.length > 0) {
      console.error('[architecture] store dependency cycles (static + dynamic):');
      for (const cycle of dsm.storeCycles) {
        console.error(`- ${cycle.join(' <-> ')}`);
      }
    }
    if (dsm.dsmViolations.length > 0) {
      console.error('[architecture] MIT Axiomatic Design upper-triangular violations:');
      for (const violation of dsm.dsmViolations) {
        console.error(`- ${violation.file} -> ${violation.target}: ${violation.reason}`);
      }
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `[architecture] scanned ${reports.length} Tauri-touching files; ${legacyCount} legacy exceptions unchanged; DSM verified 0 static cycles, 0 store cycles, 0 upper-triangular violations`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
