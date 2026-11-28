import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  cleanupCardManagedWorktree,
  IDLE_WORKTREE_TTL_MS,
  isRetiredWorktreePath,
  pruneCleanFinishedWorktrees,
  setWorktreeLifecycleDriversForTests,
  sweepIdleManagedWorktrees,
} from '../../apps/web/src/agent/worktreeLifecycle';
import {
  diffExternalWorkspacePulse,
  type ExternalWorkspacePulse,
} from '../../apps/web/src/lib/externalContinuation';
import { beginWorkLedgerAccount, useWorkLedger } from '../../apps/web/src/stores/workLedger';
import {
  scanAxiomaticDesignMatrix,
  scanRustAsyncCommandBlocking,
} from '../check-architecture-boundaries.mjs';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(THIS_DIR, '..', '..');

function installMemoryStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
    },
  });
}

function makePulse(overrides: Partial<ExternalWorkspacePulse> = {}): ExternalWorkspacePulse {
  return {
    workspaceRoot: 'd:/Repos/demo',
    externalWriterActive: false,
    writerHint: null,
    transcriptMtimeMs: 1700000000000,
    transcriptSizeBytes: 2048,
    latestMessages: [
      { id: 'm1', role: 'user', text: 'check build', timestamp: 1700000001000 },
      { id: 'm2', role: 'assistant', text: 'all checks passed', timestamp: 1700000002000 },
    ],
    gitSnapshot: {
      contentFingerprint: 'fp-1',
      workspaceRoot: 'd:/Repos/demo',
      repoTopLevel: 'd:/Repos/demo',
      branch: 'main',
      headSha: 'abc1234',
      isWorktree: false,
      dirtyFiles: [],
      diffStat: null,
      recentCommits: [],
      unpushedCommits: 0,
      hasUntracked: false,
    },
    ...overrides,
  };
}

test('diffExternalWorkspacePulse：单写者锁、Git 基线变化、增量消息与非 Git 容错', () => {
  const locked = diffExternalWorkspacePulse(
    { gitFingerprint: 'fp-1', knownMessageIds: ['m1', 'm2'] },
    makePulse({
      externalWriterActive: true,
      writerHint: 'codex CLI (pid 4242) 正在写入当前会话',
    }),
  );
  assert.equal(locked.externalWriterActive, true);
  assert.equal(locked.lockComposer, true);
  assert.equal(locked.writerHint, 'codex CLI (pid 4242) 正在写入当前会话');
  assert.equal(locked.gitChangedSinceBaseline, false);
  assert.equal(locked.newExternalMessages.length, 0);

  const delta = diffExternalWorkspacePulse(
    { gitFingerprint: 'fp-1', knownMessageIds: ['m1', 'm2'] },
    makePulse({
      latestMessages: [
        { id: 'm1', role: 'user', text: 'check build', timestamp: 1700000001000 },
        { id: 'm2', role: 'assistant', text: 'all checks passed', timestamp: 1700000002000 },
        { id: 'm3', role: 'assistant', text: 'edited src/app.ts externally', timestamp: 1700000003000 },
      ],
      gitSnapshot: {
        ...makePulse().gitSnapshot!,
        contentFingerprint: 'fp-2',
        dirtyFiles: [' M src/app.ts'],
        unpushedCommits: 1,
      },
    }),
  );
  assert.equal(delta.lockComposer, false);
  assert.equal(delta.gitChangedSinceBaseline, true);
  assert.equal(delta.dirtyCount, 1);
  assert.equal(delta.unpushedCount, 1);
  assert.deepEqual(
    delta.newExternalMessages.map((m) => m.id),
    ['m3'],
  );
  assert.equal(delta.latestMessagePreview, 'edited src/app.ts externally');

  const nonGit = diffExternalWorkspacePulse(
    { gitFingerprint: null, knownMessageIds: [] },
    makePulse({ gitSnapshot: null }),
  );
  assert.equal(nonGit.gitChangedSinceBaseline, false);
  assert.equal(nonGit.dirtyCount, 0);
  assert.equal(nonGit.unpushedCount, 0);
});

test('worktreeLifecycle：拦截 unpushedCommits 与 hasUntracked，并在干净回收后记录 retiredWorktreePaths', async () => {
  installMemoryStorage();
  beginWorkLedgerAccount('phase1-guard@rocketx.test');

  const wtPath = 'd:/wt/phase1-guard-case';
  const removed: string[] = [];
  let gitState = {
    dirtyFiles: [] as string[],
    hasUntracked: false,
    unpushedCommits: 2,
  };

  setWorktreeLifecycleDriversForTests({
    isDesktop: () => true,
    inspectGit: async (root) => ({
      contentFingerprint: 'fp-wt',
      workspaceRoot: root,
      repoTopLevel: 'd:/Repos/rocketchatx',
      branch: 'ai/phase1-guard',
      headSha: 'deadbeef',
      isWorktree: root !== 'd:/Repos/rocketchatx',
      dirtyFiles: gitState.dirtyFiles,
      diffStat: null,
      recentCommits: [],
      hasUntracked: gitState.hasUntracked,
      unpushedCommits: gitState.unpushedCommits,
    }),
    createCheckpoint: async () => ({ id: 'cp-1' }),
    listWorktrees: async () => [
      {
        path: wtPath,
        headSha: 'deadbeef',
        branch: 'ai/phase1-guard',
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
        isCurrent: false,
        isManaged: true,
      },
    ],
    removeWorktree: async (_repoRoot, path) => {
      removed.push(path);
    },
  });

  useWorkLedger.setState({
    cards: [
      {
        id: 'card-phase1-done',
        source: 'manual',
        done: true,
        title: 'Phase 1 card',
        createdAt: 1,
        updatedAt: 1,
        state: { todoId: 'card-phase1-done', stage: 'done' },
      } as never,
    ],
    links: [
      {
        todoId: 'card-phase1-done',
        repo: 'd:/Repos/rocketchatx',
        stateSnapshot: 'ready',
      } as never,
    ],
    sessions: [
      {
        id: 'sess-phase1-wt',
        todoId: 'card-phase1-done',
        workspaceRoot: wtPath,
        runtimeStatus: 'ready',
        configSnapshotJson: JSON.stringify({ isolatedWorktree: true }),
        updatedAt: Date.now() - IDLE_WORKTREE_TTL_MS - 10_000,
      } as never,
    ],
  });

  try {
    // 1) 存在 unpushedCommits > 0 时，三类自动回收全部拦截
    assert.deepEqual(await pruneCleanFinishedWorktrees('d:/Repos/rocketchatx'), []);
    assert.equal(await cleanupCardManagedWorktree('card-phase1-done'), false);
    const sweepUnpushed = await sweepIdleManagedWorktrees(['d:/Repos/rocketchatx']);
    assert.deepEqual(sweepUnpushed.removed, []);
    assert.deepEqual(sweepUnpushed.skippedDirty, [wtPath]);
    assert.equal(removed.length, 0);

    // 2) 存在 hasUntracked = true 时，三类自动回收全部拦截
    gitState = { dirtyFiles: [], hasUntracked: true, unpushedCommits: 0 };
    assert.deepEqual(await pruneCleanFinishedWorktrees('d:/Repos/rocketchatx'), []);
    assert.equal(await cleanupCardManagedWorktree('card-phase1-done'), false);
    const sweepUntracked = await sweepIdleManagedWorktrees(['d:/Repos/rocketchatx']);
    assert.deepEqual(sweepUntracked.removed, []);
    assert.deepEqual(sweepUntracked.skippedDirty, [wtPath]);
    assert.equal(removed.length, 0);

    // 3) 干净且已推送时允许回收，并记录 retiredWorktreePaths
    gitState = { dirtyFiles: [], hasUntracked: false, unpushedCommits: 0 };
    const cleaned = await cleanupCardManagedWorktree('card-phase1-done');
    assert.equal(cleaned, true);
    assert.deepEqual(removed, [wtPath]);
    assert.equal(isRetiredWorktreePath(wtPath), true);
  } finally {
    setWorktreeLifecycleDriversForTests(null);
  }
});

test('ButlerTerminalDrawer.tsx：真实 xterm/PTY 接线、引用回流与无 CSS 直引约束', async () => {
  const source = await readFile(
    join(REPO_ROOT, 'apps', 'web', 'src', 'components', 'ButlerTerminalDrawer.tsx'),
    'utf8',
  );
  assert.match(source, /@xterm\/xterm/);
  assert.match(source, /@xterm\/addon-fit/);
  assert.match(source, /\bstartButlerPty\b/);
  assert.match(source, /\blistenButlerPtyOutput\b/);
  assert.match(source, /\bonQuoteSelection\b/);
  assert.doesNotMatch(source, /\.css['"]/);

  const marker = 'if (!open) return null;';
  const markerIndex = source.indexOf(marker);
  assert.ok(markerIndex > 0);
  const afterReturn = source.slice(markerIndex + marker.length);
  assert.doesNotMatch(afterReturn, /\buse(?:State|Effect|Memo|Callback|Ref)\s*\(/);
});

test('MIT 公理设计 DSM 下三角矩阵与 Rust async command 阻塞调用棘轮门禁', async () => {
  const dsm = await scanAxiomaticDesignMatrix();
  assert.deepEqual(dsm.runtimeStaticCycles, []);
  assert.deepEqual(dsm.storeCycles, []);
  assert.deepEqual(dsm.dsmViolations, []);

  const sandboxDir = await mkdtemp(join(tmpdir(), 'rcx-rust-ratchet-'));
  try {
    await writeFile(
      join(sandboxDir, 'probe.rs'),
      `
use std::time::Duration;

#[tauri::command]
pub async fn bad_cmd() -> Result<(), String> {
    std::thread::sleep(Duration::from_millis(10));
    Ok(())
}

#[tauri::command]
pub async fn ok_cmd() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        std::thread::sleep(Duration::from_millis(10));
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}
`,
      'utf8',
    );
    const violations = await scanRustAsyncCommandBlocking(sandboxDir);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].target, 'async command bad_cmd');
  } finally {
    await rm(sandboxDir, { recursive: true, force: true });
  }
});
