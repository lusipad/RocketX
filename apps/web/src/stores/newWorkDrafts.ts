import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { subscribeButlerAccountSelection } from '../platform/butlerAccountReady';
import { useAuth } from './auth';
import { resolveButlerAccountScope } from './butlerMemory';
import { useCodexWorkspace } from './codexWorkspace';

interface NewWorkRequest {
  id: string;
  signature: string;
  revision: number;
  goal: string;
  workspace: string;
}

interface NewWorkDraft {
  goal: string;
  workspace: string;
  profileId: string;
  open: boolean;
  revision: number;
  error: string | null;
  request: NewWorkRequest | null;
  pending: NewWorkRequest | null;
}

const EMPTY: NewWorkDraft = { goal: '', workspace: '', profileId: '', open: false, revision: 0, error: null, request: null, pending: null };

interface NewWorkDraftState {
  drafts: Record<string, NewWorkDraft>;
  edit: (key: string, patch: Partial<Pick<NewWorkDraft, 'goal' | 'workspace' | 'profileId' | 'open' | 'error'>>) => void;
  begin: (key: string) => NewWorkRequest | null;
  finish: (key: string, requestId: string, error?: string) => void;
}

// View changes only unmount the form; its owner and in-flight request remain the same.
export const useNewWorkDrafts = create<NewWorkDraftState>((set, get) => ({
  drafts: {},
  edit: (key, patch) => {
    const draft = get().drafts[key] ?? EMPTY;
    const changed = (patch.goal !== undefined && patch.goal !== draft.goal)
      || (patch.workspace !== undefined && patch.workspace !== draft.workspace)
      || (patch.profileId !== undefined && patch.profileId !== draft.profileId);
    set((state) => ({ drafts: { ...state.drafts, [key]: { ...draft, ...patch,
      ...(patch.workspace !== undefined && patch.workspace !== draft.workspace ? { profileId: '' } : {}),
      revision: draft.revision + (changed ? 1 : 0), ...(changed ? { error: null } : {}) } } }));
  },
  begin: (key) => {
    const draft = get().drafts[key] ?? EMPTY;
    if (draft.pending || !draft.goal.trim() || !draft.workspace.trim()) return null;
    const goal = draft.goal.trim(); const workspace = draft.workspace.trim();
    const signature = JSON.stringify([goal, workspace]);
    const request = { id: draft.request?.signature === signature ? draft.request.id : crypto.randomUUID(),
      signature, revision: draft.revision, goal, workspace };
    set((state) => ({ drafts: { ...state.drafts, [key]: { ...draft, request, pending: request, error: null } } }));
    return request;
  },
  finish: (key, requestId, error) => {
    const draft = get().drafts[key];
    if (draft?.pending?.id !== requestId) return;
    const changed = draft.revision !== draft.pending.revision;
    set((state) => ({ drafts: { ...state.drafts, [key]: error === undefined
      ? { ...(changed ? draft : EMPTY), revision: draft.revision + 1, request: null, pending: null }
      : { ...draft, pending: null, error: changed ? null : error } } }));
  },
}));

export function newWorkDraftKey(): string {
  return JSON.stringify([resolveButlerAccountScope(), useCodexWorkspace.getState().scope]);
}

function subscribeScope(listener: () => void): () => void {
  const stopAccount = subscribeButlerAccountSelection(listener);
  const stopAuth = useAuth.subscribe(listener);
  const stopRuntime = useCodexWorkspace.subscribe((state, previous) => { if (state.scope !== previous.scope) listener(); });
  return () => { stopAccount(); stopAuth(); stopRuntime(); };
}

export function useNewWorkDraft() {
  const key = useSyncExternalStore(subscribeScope, newWorkDraftKey, newWorkDraftKey);
  const draft = useNewWorkDrafts((state) => state.drafts[key] ?? EMPTY);
  return { key, draft };
}
