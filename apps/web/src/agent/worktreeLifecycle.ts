import { t } from '../i18n';
import { isTauriRuntime } from '../lib/client';
import { workContextPathKey } from '../lib/workContext';
import {
  createGitCheckpoint,
  inspectNativeWorkspaceGit,
  listGitWorktrees,
  removeNativeWorktree,
  type GitWorktreeItem,
  type NativeWorkspaceGitSnapshot,
} from '../platform/desktopCommands';
import { normalizeEnvironmentPath } from '../stores/agentEnvironments';
import { useWorkLedger } from '../stores/workLedger';

export const MAX_MANAGED_WORKTREES_PER_REPO = 3;
export const IDLE_WORKTREE_TTL_MS = 48 * 60 * 60 * 1000;
const retiredWorktreePaths = new Set<string>();

export function isRetiredWorktreePath(worktreePath: string): boolean {
  return retiredWorktreePaths.has(workContextPathKey(worktreePath));
}

export interface WorktreeExecutionPlan {
  mode: 'in_place_checkpoint' | 'isolated_worktree';
  workspaceRoot: string;
  isolateWorktree: boolean;
  checkpointId?: string;
  reusedExisting?: boolean;
  prunedCount?: number;
}

export interface WorktreeLifecycleDrivers {
  isDesktop: () => boolean;
  inspectGit: (workspaceRoot: string) => Promise<NativeWorkspaceGitSnapshot>;
  createCheckpoint: (
    workspaceRoot: string,
    label: string,
  ) => Promise<{ id: string } | null>;
  listWorktrees: (repoRoot: string) => Promise<GitWorktreeItem[]>;
  removeWorktree: (repoRoot: string, worktreePath: string) => Promise<void>;
}

const defaultDrivers: WorktreeLifecycleDrivers = {
  isDesktop: () => isTauriRuntime(),
  inspectGit: (workspaceRoot) => inspectNativeWorkspaceGit(workspaceRoot),
  createCheckpoint: async (workspaceRoot, label) => {
    const res = await createGitCheckpoint(workspaceRoot, label, null);
    return { id: res.id };
  },
  listWorktrees: (repoRoot) => listGitWorktrees(repoRoot),
  removeWorktree: (repoRoot, worktreePath) => removeNativeWorktree(repoRoot, worktreePath),
};

let activeDrivers: WorktreeLifecycleDrivers = defaultDrivers;

export function setWorktreeLifecycleDriversForTests(
  overrides: Partial<WorktreeLifecycleDrivers> | null,
): void {
  activeDrivers = overrides ? { ...defaultDrivers, ...overrides } : defaultDrivers;
}

function isIsolatedWorktreeSession(configSnapshotJson: string | null | undefined): boolean {
  return Boolean(configSnapshotJson?.includes('"isolatedWorktree":true'));
}

function resolveRepoRootForCard(cardId: string): string {
  const { sessions, links } = useWorkLedger.getState();
  const wsLink = links.find(
    (l) => l.todoId === cardId && l.repo?.trim() && l.stateSnapshot !== 'isolated_worktree',
  );
  if (wsLink?.repo?.trim()) return wsLink.repo.trim();

  const nonIsolated = sessions.find(
    (s) =>
      s.todoId === cardId
      && s.workspaceRoot.trim()
      && !isIsolatedWorktreeSession(s.configSnapshotJson),
  );
  return nonIsolated?.workspaceRoot.trim() ?? '';
}

/**
 * 清理指定仓库下已完成且工作区干净的受管 Worktree（永不误删有未提交改动的目录）。
 */
export async function pruneCleanFinishedWorktrees(repoRoot: string): Promise<string[]> {
  if (!repoRoot.trim() || !activeDrivers.isDesktop()) return [];
  const items = await activeDrivers.listWorktrees(repoRoot).catch(() => [] as GitWorktreeItem[]);
  const { cards, sessions } = useWorkLedger.getState();
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const removed: string[] = [];

  for (const wt of items) {
    if (!wt.isManaged || wt.isCurrent) continue;
    const wtKey = workContextPathKey(wt.path);
    const matchingSessions = sessions.filter((s) => workContextPathKey(s.workspaceRoot) === wtKey);
    const hasRunning = matchingSessions.some((s) => s.runtimeStatus === 'running');
    if (hasRunning) continue;

    const linkedCard = matchingSessions
      .map((s) => (s.todoId ? cardById.get(s.todoId) : undefined))
      .find((c) => Boolean(c));
    const finished = !linkedCard || linkedCard.done || linkedCard.state?.stage === 'done';
    if (!finished) continue;

    const snap = await activeDrivers.inspectGit(wt.path).catch(() => null);
    if (
      !snap ||
      snap.dirtyFiles.length > 0 ||
      snap.hasUntracked ||
      (snap.unpushedCommits ?? 0) > 0
    ) {
      continue;
    }

    await activeDrivers.removeWorktree(repoRoot, wt.path).catch(() => undefined);
    retiredWorktreePaths.add(wtKey);
    removed.push(wt.path);
  }

  return removed;
}

/**
 * 4 层防 Worktree 爆炸调度：
 * 1. 同一张工作卡严格复用已有 Worktree；
 * 2. 单线且干净的主仓库默认「原位快改 + Git Checkpoint」（0 Worktree，秒复用 node_modules 与缓存）；
 * 3. 仅在并发写入、主仓库已脏或显式指定隔离时才启用受管 Worktree；
 * 4. 达到上限（3 个）先自动回收已完结且干净的旧 Worktree，仍满则拒绝新建。
 */
export async function planSafeExecutionWorkspace(input: {
  repoRoot: string;
  cardId: string;
  forceIsolateWorktree?: boolean;
}): Promise<WorktreeExecutionPlan> {
  const repoRoot = input.repoRoot.trim();
  const { sessions } = useWorkLedger.getState();

  const existingWorktree = sessions.find(
    (s) =>
      s.todoId === input.cardId
      && isIsolatedWorktreeSession(s.configSnapshotJson)
      && s.workspaceRoot.trim().length > 0,
  );
  if (existingWorktree) {
    return {
      mode: 'isolated_worktree',
      workspaceRoot: existingWorktree.workspaceRoot,
      isolateWorktree: true,
      reusedExisting: true,
    };
  }

  const repoKey = normalizeEnvironmentPath(repoRoot);
  const hasConcurrentWriter = sessions.some(
    (s) =>
      s.todoId !== input.cardId
      && s.runtimeStatus === 'running'
      && normalizeEnvironmentPath(s.workspaceRoot) === repoKey,
  );

  let dirtyFiles: string[] = [];
  if (repoRoot && activeDrivers.isDesktop()) {
    const snap = await activeDrivers.inspectGit(repoRoot).catch(() => null);
    if (snap) {
      dirtyFiles = snap.dirtyFiles;
    }
  }

  if (!input.forceIsolateWorktree && !hasConcurrentWriter && dirtyFiles.length === 0) {
    let checkpointId: string | undefined;
    if (repoRoot && activeDrivers.isDesktop()) {
      const cp = await activeDrivers
        .createCheckpoint(repoRoot, `roundtable-${input.cardId.slice(0, 8)}`)
        .catch(() => null);
      checkpointId = cp?.id;
    }
    return {
      mode: 'in_place_checkpoint',
      workspaceRoot: repoRoot,
      isolateWorktree: false,
      checkpointId,
    };
  }

  let prunedCount = 0;
  if (repoRoot && activeDrivers.isDesktop()) {
    const listBefore = await activeDrivers.listWorktrees(repoRoot).catch(() => [] as GitWorktreeItem[]);
    const managedBefore = listBefore.filter((w) => w.isManaged && !w.isCurrent);
    if (managedBefore.length >= MAX_MANAGED_WORKTREES_PER_REPO) {
      const pruned = await pruneCleanFinishedWorktrees(repoRoot);
      prunedCount = pruned.length;
      const listAfter = await activeDrivers.listWorktrees(repoRoot).catch(() => [] as GitWorktreeItem[]);
      const managedAfter = listAfter.filter((w) => w.isManaged && !w.isCurrent);
      if (managedAfter.length >= MAX_MANAGED_WORKTREES_PER_REPO) {
        throw new Error(
          t('chat.aiParticipant.worktreeQuotaReached', { limit: MAX_MANAGED_WORKTREES_PER_REPO }),
        );
      }
    }
  }

  return {
    mode: 'isolated_worktree',
    workspaceRoot: repoRoot,
    isolateWorktree: true,
    prunedCount: prunedCount || undefined,
  };
}

/**
 * 工作卡完成后安全回收关联的受管 Worktree；若仍存在未提交改动则保留目录防丢代码。
 */
export async function cleanupCardManagedWorktree(cardId: string): Promise<boolean> {
  if (!activeDrivers.isDesktop()) return false;
  const { sessions } = useWorkLedger.getState();
  const isolatedSession = sessions.find(
    (s) =>
      s.todoId === cardId
      && isIsolatedWorktreeSession(s.configSnapshotJson)
      && s.workspaceRoot.trim().length > 0,
  );
  if (!isolatedSession) return false;

  const repoRoot = resolveRepoRootForCard(cardId);
  if (!repoRoot) return false;

  const snap = await activeDrivers.inspectGit(isolatedSession.workspaceRoot).catch(() => null);
  if (
    !snap ||
    snap.dirtyFiles.length > 0 ||
    snap.hasUntracked ||
    (snap.unpushedCommits ?? 0) > 0
  ) {
    return false;
  }

  await activeDrivers.removeWorktree(repoRoot, isolatedSession.workspaceRoot);
  retiredWorktreePaths.add(workContextPathKey(isolatedSession.workspaceRoot));
  return true;
}

/**
 * 定时巡检 / 管家 Dream 扫除超时（默认 48h）且干净的闲置受管 Worktree。
 */
export async function sweepIdleManagedWorktrees(
  repoRoots: readonly string[],
  now = Date.now(),
): Promise<{ removed: string[]; skippedDirty: string[] }> {
  if (!activeDrivers.isDesktop()) return { removed: [], skippedDirty: [] };
  const { cards, sessions } = useWorkLedger.getState();
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const removed: string[] = [];
  const skippedDirty: string[] = [];

  for (const repoRoot of repoRoots) {
    if (!repoRoot.trim()) continue;
    const worktrees = await activeDrivers.listWorktrees(repoRoot).catch(() => [] as GitWorktreeItem[]);
    for (const wt of worktrees) {
      if (!wt.isManaged || wt.isCurrent) continue;
      const wtKey = workContextPathKey(wt.path);
      const matching = sessions.filter((s) => workContextPathKey(s.workspaceRoot) === wtKey);
      if (matching.some((s) => s.runtimeStatus === 'running')) continue;

      const latestUpdatedAt = matching.reduce((max, s) => Math.max(max, s.updatedAt ?? 0), 0);
      const allCardsDone =
        matching.length > 0
        && matching.every((s) => {
          const card = s.todoId ? cardById.get(s.todoId) : undefined;
          return !card || card.done || card.state?.stage === 'done';
        });
      const expired = latestUpdatedAt > 0 && now - latestUpdatedAt >= IDLE_WORKTREE_TTL_MS;
      if (!allCardsDone && !expired) continue;

      const snap = await activeDrivers.inspectGit(wt.path).catch(() => null);
      if (!snap) continue;
      if (
        snap.dirtyFiles.length > 0 ||
        snap.hasUntracked ||
        (snap.unpushedCommits ?? 0) > 0
      ) {
        skippedDirty.push(wt.path);
        continue;
      }
      await activeDrivers.removeWorktree(repoRoot, wt.path).catch(() => undefined);
      retiredWorktreePaths.add(wtKey);
      removed.push(wt.path);
    }
  }

  return { removed, skippedDirty };
}

/**
 * 监听 WorkLedger 卡片完结事件，自动回收干净的隔离 Worktree。
 */
export function startWorktreeLifecycleBridge(): () => void {
  const finishedIds = new Set<string>();
  for (const card of useWorkLedger.getState().cards) {
    if (card.done || card.state?.stage === 'done') {
      finishedIds.add(card.id);
    }
  }

  return useWorkLedger.subscribe((state) => {
    for (const card of state.cards) {
      const isFinished = card.done || card.state?.stage === 'done';
      if (isFinished && !finishedIds.has(card.id)) {
        finishedIds.add(card.id);
        void cleanupCardManagedWorktree(card.id).catch(() => undefined);
      } else if (!isFinished && finishedIds.has(card.id)) {
        finishedIds.delete(card.id);
      }
    }
  });
}
