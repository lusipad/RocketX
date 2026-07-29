import { AppServerClient, TauriCodexTransport } from '../../../agent/protocol';
import type { Thread } from '../../../agent/protocol/generated/v2/Thread';
import { isTauri } from '../../../lib/http';
import type { Build, PullRequest, WorkItem } from '../../../stores/workbench';
import {
  normalizeButlerLearningText,
  type ProfileBootstrapSourceId,
  type ProfileFactSourceSnapshot,
} from './model';

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_RECENT_CODEX_SNAPSHOTS = 20;
const MAX_PROFILE_SOURCE_SNAPSHOTS = 20;
const RECENT_WINDOW_DAYS = 14;
const SENSITIVE_PATTERN =
  /(password|passwd|token|secret|api[-_ ]?key|credential|system prompt|权限|授权|密钥|密码|令牌|凭据)/i;

export interface ProfileBootstrapSelection {
  currentConnection: boolean;
  recentCodex: boolean;
  recentClaude: boolean;
}

export interface ProfileBootstrapCurrentConnectionInput {
  authName?: string;
  authUsername?: string;
  adoAccount?: string;
  adoBase?: string;
  workItems: readonly WorkItem[];
  prs: readonly PullRequest[];
  builds: readonly Build[];
}

export interface ProfileBootstrapSourceAvailabilityError {
  sourceId: ProfileBootstrapSourceId;
  message: string;
}

export interface CollectProfileBootstrapSourcesInput {
  now?: number;
  selection: ProfileBootstrapSelection;
  currentConnection: ProfileBootstrapCurrentConnectionInput;
  manualSupplement?: string;
}

export interface CollectProfileBootstrapSourcesResult {
  snapshots: ProfileFactSourceSnapshot[];
  unavailable: ProfileBootstrapSourceAvailabilityError[];
}

interface RecentProfileSourceLoaderOptions {
  now: number;
  maxSnapshots: number;
  windowDays: number;
}

interface RecentCodexClient {
  start(): Promise<unknown>;
  stop(): Promise<void>;
  request(method: 'thread/list', params: Record<string, unknown>, timeoutMs?: number): Promise<{
    data: Thread[];
  }>;
  request(method: 'thread/read', params: Record<string, unknown>, timeoutMs?: number): Promise<{
    thread: Thread;
  }>;
}

type RecentProfileSourceLoader = (
  options: RecentProfileSourceLoaderOptions,
) => Promise<ProfileFactSourceSnapshot[]>;

type RecentCodexWorkspaceResolver = (sessionId: string) => Promise<string>;
type RecentCodexClientFactory = (
  sessionId: string,
  workspaceRoot: string,
) => RecentCodexClient;

function compactMultiline(value: string, maxLength = 1_000): string {
  return value
    .split(/\r?\n/)
    .map((line) => normalizeButlerLearningText(line, maxLength))
    .filter(Boolean)
    .join('\n')
    .slice(0, maxLength);
}

function safeSnippet(value: string, maxLength = 180): string {
  const normalized = normalizeButlerLearningText(value, maxLength);
  if (!normalized) return '';
  return SENSITIVE_PATTERN.test(normalized)
    ? '疑似敏感内容已省略'
    : normalized;
}

function currentProjectSummary(
  workItems: readonly WorkItem[],
  prs: readonly PullRequest[],
  builds: readonly Build[],
): string | null {
  const counts = new Map<string, number>();
  for (const project of [
    ...workItems.map((item) => item.project),
    ...prs.map((pr) => pr.project ?? ''),
    ...builds.map((build) => build.project),
  ]) {
    const name = project.trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-CN'))
    .slice(0, 3)
    .map(([name]) => name);
  return names.length ? names.join('、') : null;
}

function describeCurrentTitles(
  label: string,
  values: readonly string[],
): string | null {
  const items = values
    .map((value) => safeSnippet(value, 80))
    .filter(Boolean)
    .slice(0, 3);
  return items.length ? `${label}：${items.join('；')}` : null;
}

export function buildCurrentConnectionBootstrapSnapshot(
  input: ProfileBootstrapCurrentConnectionInput,
  now = Date.now(),
): ProfileFactSourceSnapshot | null {
  const username = input.authUsername?.trim();
  const name = input.authName?.trim();
  const lines = [
    username
      ? `Rocket.Chat 身份：${name && name !== username ? `${name}（@${username}）` : `@${username}`}`
      : null,
    input.adoAccount?.trim() ? `Azure DevOps 账号：${input.adoAccount.trim()}` : null,
    input.adoBase?.trim() ? `Azure DevOps 集合：${input.adoBase.trim()}` : null,
    currentProjectSummary(input.workItems, input.prs, input.builds)
      ? `当前工作项目：${currentProjectSummary(input.workItems, input.prs, input.builds)}`
      : null,
    describeCurrentTitles('最近工作项', input.workItems.map((item) => item.title)),
    describeCurrentTitles('最近 PR', input.prs.map((pr) => pr.title)),
    describeCurrentTitles('最近构建', input.builds.map((build) => build.definition || build.reason || '构建')),
  ].filter((line): line is string => !!line);
  if (!lines.length) return null;
  return {
    id: `current-connection:${now}`,
    sourceId: 'current-connection',
    label: '当前连接',
    snapshot: compactMultiline(lines.join('\n')),
    capturedAt: now,
  };
}

function userInputText(thread: Thread): string[] {
  const texts: string[] = [];
  const turns = [...(thread.turns ?? [])]
    .sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0));
  for (const turn of turns) {
    for (const item of turn.items ?? []) {
      if (item.type === 'userMessage') {
        const value = item.content
          .filter((content) => content.type === 'text')
          .map((content) => content.text)
          .join(' ');
        const snippet = safeSnippet(value);
        if (snippet) texts.push(`用户：${snippet}`);
      }
      if (item.type === 'agentMessage') {
        const snippet = safeSnippet(item.text);
        if (snippet) texts.push(`助手：${snippet}`);
      }
    }
  }
  return texts.slice(-6);
}

export function buildReadonlyCodexThreadSnapshot(
  thread: Thread,
  now = Date.now(),
): ProfileFactSourceSnapshot | null {
  const updatedAtMs = (thread.updatedAt || thread.createdAt) * 1_000;
  if (updatedAtMs < now - RECENT_WINDOW_DAYS * DAY_MS) return null;
  const title = safeSnippet(thread.name || thread.preview || '未命名会话', 80);
  const lines = userInputText(thread);
  if (!title && lines.length === 0) return null;
  const snapshot = compactMultiline([
    title ? `会话：${title}` : null,
    ...lines,
  ].filter((line): line is string => !!line).join('\n'));
  if (!snapshot) return null;
  return {
    id: thread.id,
    sourceId: 'recent-codex',
    label: title ? `最近 Codex · ${title}` : '最近 Codex',
    snapshot,
    capturedAt: updatedAtMs,
  };
}

async function loadRecentCodexSourceSnapshotsDefault(
  options: RecentProfileSourceLoaderOptions,
): Promise<ProfileFactSourceSnapshot[]> {
  if (
    !isTauri
    && recentCodexWorkspaceResolver === defaultRecentCodexWorkspaceResolver
    && recentCodexClientFactory === defaultRecentCodexClientFactory
  ) {
    throw new Error('最近 Codex 只在桌面端可用。');
  }
  const sessionId = `profile-bootstrap-${crypto.randomUUID()}`;
  const workspaceRoot = await recentCodexWorkspaceResolver(sessionId);
  const client = recentCodexClientFactory(sessionId, workspaceRoot);
  try {
    await client.start();
    const listed = await client.request('thread/list', {
      limit: options.maxSnapshots,
      archived: false,
    }, 30_000);
    const snapshots: ProfileFactSourceSnapshot[] = [];
    for (const summary of listed.data) {
      if (snapshots.length >= options.maxSnapshots) break;
      const updatedAtMs = (summary.updatedAt || summary.createdAt) * 1_000;
      if (updatedAtMs < options.now - options.windowDays * DAY_MS) continue;
      const detailed = await client.request('thread/read', {
        threadId: summary.id,
        includeTurns: true,
      }, 30_000);
      const snapshot = buildReadonlyCodexThreadSnapshot(detailed.thread, options.now);
      if (snapshot) snapshots.push(snapshot);
    }
    if (!snapshots.length) {
      throw new Error(`最近 ${options.windowDays} 天没有可用的 Codex 会话摘要。`);
    }
    return snapshots;
  } finally {
    await client.stop().catch(() => undefined);
  }
}

async function loadRecentClaudeSourceSnapshotsDefault(): Promise<ProfileFactSourceSnapshot[]> {
  throw new Error('最近 Claude 暂不支持安全直读；请先把最近 14 天的摘要导入到补充摘要后再生成。');
}

let recentCodexSourceLoader: RecentProfileSourceLoader = loadRecentCodexSourceSnapshotsDefault;
let recentClaudeSourceLoader: RecentProfileSourceLoader = loadRecentClaudeSourceSnapshotsDefault;
const defaultRecentCodexWorkspaceResolver: RecentCodexWorkspaceResolver = async (sessionId) => {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('codex_agent_workspace', { sessionId });
};
const defaultRecentCodexClientFactory: RecentCodexClientFactory = (sessionId, workspaceRoot) =>
  new AppServerClient(new TauriCodexTransport(sessionId, workspaceRoot));
let recentCodexWorkspaceResolver: RecentCodexWorkspaceResolver = defaultRecentCodexWorkspaceResolver;
let recentCodexClientFactory: RecentCodexClientFactory = defaultRecentCodexClientFactory;

export function setRecentCodexSourceLoader(loader: RecentProfileSourceLoader): () => void {
  const previous = recentCodexSourceLoader;
  recentCodexSourceLoader = loader;
  return () => {
    recentCodexSourceLoader = previous;
  };
}

export function setRecentClaudeSourceLoader(loader: RecentProfileSourceLoader): () => void {
  const previous = recentClaudeSourceLoader;
  recentClaudeSourceLoader = loader;
  return () => {
    recentClaudeSourceLoader = previous;
  };
}

export function setRecentCodexWorkspaceResolver(
  resolver: RecentCodexWorkspaceResolver,
): () => void {
  const previous = recentCodexWorkspaceResolver;
  recentCodexWorkspaceResolver = resolver;
  return () => {
    recentCodexWorkspaceResolver = previous;
  };
}

export function setRecentCodexClientFactory(
  factory: RecentCodexClientFactory,
): () => void {
  const previous = recentCodexClientFactory;
  recentCodexClientFactory = factory;
  return () => {
    recentCodexClientFactory = previous;
  };
}

function buildManualImportSnapshot(text: string, now: number): ProfileFactSourceSnapshot | null {
  const snapshot = compactMultiline(
    text
      .split(/\r?\n/)
      .map((line) => safeSnippet(line, 240))
      .filter(Boolean)
      .join('\n'),
    1_200,
  );
  if (!snapshot) return null;
  return {
    id: `manual-import:${now}`,
    sourceId: 'manual-import',
    label: '手动导入摘要',
    snapshot,
    capturedAt: now,
  };
}

export async function collectProfileBootstrapSources(
  input: CollectProfileBootstrapSourcesInput,
): Promise<CollectProfileBootstrapSourcesResult> {
  const now = input.now ?? Date.now();
  const snapshots: ProfileFactSourceSnapshot[] = [];
  const unavailable: ProfileBootstrapSourceAvailabilityError[] = [];

  if (input.selection.currentConnection) {
    const snapshot = buildCurrentConnectionBootstrapSnapshot(input.currentConnection, now);
    if (snapshot) snapshots.push(snapshot);
  }

  const manualSnapshot = buildManualImportSnapshot(input.manualSupplement ?? '', now);
  if (manualSnapshot) snapshots.push(manualSnapshot);

  if (input.selection.recentCodex) {
    try {
      snapshots.push(...await recentCodexSourceLoader({
        now,
        maxSnapshots: MAX_RECENT_CODEX_SNAPSHOTS,
        windowDays: RECENT_WINDOW_DAYS,
      }));
    } catch (error) {
      unavailable.push({
        sourceId: 'recent-codex',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (input.selection.recentClaude) {
    try {
      snapshots.push(...await recentClaudeSourceLoader({
        now,
        maxSnapshots: MAX_RECENT_CODEX_SNAPSHOTS,
        windowDays: RECENT_WINDOW_DAYS,
      }));
    } catch (error) {
      unavailable.push({
        sourceId: 'recent-claude',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    snapshots: snapshots.slice(0, MAX_PROFILE_SOURCE_SNAPSHOTS),
    unavailable,
  };
}
