import type { CodexPermissionPreset } from '../agent/AppServerController';

type CodexFollowUpMode = 'queue' | 'steer';

export interface CodexWorkspaceProfile {
  workspaceRoot?: string;
  workspaceRoots?: string[];
  selectedModel?: string;
  selectedEffort?: string | null;
  permissionPreset?: CodexPermissionPreset;
  followUpMode?: CodexFollowUpMode;
}

const STORAGE_PREFIX = 'rcx-codex-workspace-v1';

function storageKey(scope: string): string {
  return `${STORAGE_PREFIX}:${scope}`;
}

export function readCodexWorkspaceProfile(scope: string): CodexWorkspaceProfile {
  if (!scope || typeof localStorage === 'undefined') return {};
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(scope)) ?? '{}');
    return typeof value === 'object' && value !== null ? value as CodexWorkspaceProfile : {};
  } catch {
    return {};
  }
}

export function writeCodexWorkspaceProfile(scope: string, profile: CodexWorkspaceProfile): void {
  if (!scope || typeof localStorage === 'undefined') return;
  localStorage.setItem(storageKey(scope), JSON.stringify(profile));
}

export function workspacePathKey(path: string): string {
  const normalized = path.trim().replaceAll('\\', '/').replace(/\/+$/u, '');
  return /^[a-z]:\//iu.test(normalized) ? normalized.toLocaleLowerCase('en-US') : normalized;
}

export function isSystemCodexWorkspace(
  path: string,
  defaultWorkspaceRoot: string,
  butlerWorkspaceRoot: string,
): boolean {
  const key = workspacePathKey(path);
  return Boolean(key) && (
    key === workspacePathKey(defaultWorkspaceRoot) ||
    key === workspacePathKey(butlerWorkspaceRoot)
  );
}
