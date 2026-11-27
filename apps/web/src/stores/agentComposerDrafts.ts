import { create } from 'zustand';
import { useEffect } from 'react';
import { t } from '../i18n';
import type { CodexImageInput } from '../lib/codexImages';

export interface AgentComposerTarget {
  kind: 'butler' | 'acp' | 'native-work';
  scope: string;
  workspaceRoot: string;
  recipientId: string | null;
}

export interface AgentComposerRequest {
  id: string;
  target: AgentComposerTarget;
  text: string;
  images: CodexImageInput[];
  options: { mode?: 'steer' | 'queue'; injectMemory?: boolean; steer?: boolean };
  error?: string;
  requiresVerification?: boolean;
}

export interface ComposerDraft {
  text: string;
  images: CodexImageInput[];
  failed: AgentComposerRequest[];
  pending?: AgentComposerRequest;
  loaded: boolean;
  saveError?: string;
}

const EMPTY: ComposerDraft = { text: '', images: [], failed: [], loaded: false };
let database: Promise<IDBDatabase> | undefined;
const loading = new Map<string, Promise<void>>();
const edited = new Map<string, Set<'text' | 'images'>>();
const imageIds = new WeakMap<CodexImageInput, string>();
const storedImages = new Set<string>();
let writeQueue = Promise.resolve();
type SavedRequest = Omit<AgentComposerRequest, 'images'> & { images: string[] };
type SavedDraft = Omit<ComposerDraft, 'images' | 'failed' | 'pending'> & {
  images: string[]; failed: SavedRequest[]; pending?: SavedRequest;
};

function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('rocketx-agent-composer-drafts', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('drafts');
      request.result.createObjectStore('images');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database.catch((error) => { database = undefined; throw error; });
}

async function readDraft(key: string): Promise<ComposerDraft | undefined> {
  const db = await openDatabase();
  const read = <T>(store: string, id: string): Promise<T> => new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const saved = await read<SavedDraft | undefined>('drafts', key);
  if (!saved) return undefined;
  const images = (ids: string[]) => Promise.all(ids.map(async (id) => {
    const image = await read<CodexImageInput>('images', id);
    if (!image) throw new Error(t('agent.drafts.missingAttachment'));
    imageIds.set(image, id);
    storedImages.add(id);
    return image;
  }));
  const request = async (value: SavedRequest): Promise<AgentComposerRequest> => ({ ...value, images: await images(value.images) });
  return {
    ...saved, images: await images(saved.images), failed: await Promise.all(saved.failed.map(request)),
    pending: saved.pending ? await request(saved.pending) : undefined,
  };
}

async function persistDraft(key: string, draft: ComposerDraft): Promise<void> {
  try {
    const db = await openDatabase();
    const newImages = new Map<string, CodexImageInput>();
    const images = (values: CodexImageInput[]) => values.map((image) => {
      const id = imageIds.get(image) ?? crypto.randomUUID();
      imageIds.set(image, id);
      if (!storedImages.has(id)) newImages.set(id, image);
      return id;
    });
    const request = (value: AgentComposerRequest): SavedRequest => ({ ...value, images: images(value.images) });
    const saved: SavedDraft = {
      ...draft, images: images(draft.images), failed: draft.failed.map(request),
      pending: draft.pending ? request(draft.pending) : undefined,
    };
    const removedImages: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(['drafts', 'images'], 'readwrite');
      for (const [id, image] of newImages) transaction.objectStore('images').put(image, id);
      transaction.objectStore('drafts').put(saved, key);
      const allDrafts = transaction.objectStore('drafts').getAll();
      allDrafts.onsuccess = () => {
        const referenced = new Set<string>();
        for (const entry of allDrafts.result as SavedDraft[]) {
          for (const id of entry.images) referenced.add(id);
          for (const request of [...entry.failed, ...(entry.pending ? [entry.pending] : [])]) {
            for (const id of request.images) referenced.add(id);
          }
        }
        const cursor = transaction.objectStore('images').openKeyCursor();
        cursor.onsuccess = () => {
          if (!cursor.result) return;
          const id = String(cursor.result.key);
          if (!referenced.has(id)) {
            transaction.objectStore('images').delete(id);
            removedImages.push(id);
          }
          cursor.result.continue();
        };
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    for (const id of newImages.keys()) storedImages.add(id);
    for (const id of removedImages) storedImages.delete(id);
  } catch {
    useAgentComposerDrafts.setState((state) => ({
      drafts: { ...state.drafts, [key]: { ...state.drafts[key], saveError: t('agent.drafts.saveFailed') } },
    }));
  }
}

export function agentComposerKey(target: AgentComposerTarget): string {
  return JSON.stringify([target.scope, target.kind, target.workspaceRoot, target.recipientId]);
}

interface ComposerState {
  drafts: Record<string, ComposerDraft>;
  load: (key: string) => Promise<void>;
  edit: (key: string, patch: Partial<Pick<ComposerDraft, 'text' | 'images'>>) => void;
  begin: (target: AgentComposerTarget, options?: AgentComposerRequest['options'], text?: string, retryId?: string) => AgentComposerRequest | null;
  bindRecipient: (key: string, requestId: string, recipientId: string) => string;
  finish: (key: string, requestId: string, error?: unknown, requiresVerification?: boolean) => void;
}

export const useAgentComposerDrafts = create<ComposerState>((set, get) => {
  const update = (key: string, draft: ComposerDraft) => {
    const next = { ...draft, saveError: undefined };
    set((state) => ({ drafts: { ...state.drafts, [key]: next } }));
    // Image data is written once; subsequent typing persists only small metadata records.
    if (next.loaded) {
      writeQueue = writeQueue.then(() => persistDraft(key, next));
    }
  };
  return {
    drafts: {},
    load: (key) => {
      if (get().drafts[key]?.loaded) return Promise.resolve();
      if (loading.has(key)) return loading.get(key)!;
      const request = readDraft(key).then((saved) => {
        if (get().drafts[key]?.loaded) return;
        // A changed account or recipient is a different key; late reads stay with their original owner.
        const draft = saved ?? EMPTY;
        const failed = [...draft.failed];
        if (draft.pending) failed.push({ ...draft.pending, error: t('agent.drafts.sendUnconfirmed'), requiresVerification: true });
        set((state) => {
          const current = state.drafts[key];
          return { drafts: { ...state.drafts, [key]: {
            ...draft, pending: undefined, failed, loaded: true,
            ...(edited.get(key)?.has('text') ? { text: current.text } : {}),
            ...(edited.get(key)?.has('images') ? { images: current.images } : {}),
          } } };
        });
        if (edited.get(key)?.size) update(key, get().drafts[key]);
      }).catch(() => {
        if (get().drafts[key]?.loaded) return;
        set((state) => ({ drafts: { ...state.drafts, [key]: { ...EMPTY, ...state.drafts[key], loaded: true, saveError: t('agent.drafts.loadFailed') } } }));
      }).finally(() => loading.delete(key));
      loading.set(key, request);
      return request;
    },
    edit: (key, patch) => {
      const fields = edited.get(key) ?? new Set<'text' | 'images'>();
      if ('text' in patch) fields.add('text');
      if ('images' in patch) fields.add('images');
      edited.set(key, fields);
      update(key, { ...(get().drafts[key] ?? EMPTY), ...patch });
    },
    begin: (target, options = {}, text, retryId) => {
      const key = agentComposerKey(target);
      const draft = get().drafts[key];
      if (!draft?.loaded || draft.pending) return null;
      const retry = retryId ? draft.failed.find((request) => request.id === retryId) : undefined;
      if (retryId && !retry) return null;
      const request: AgentComposerRequest = retry
        ? { ...retry, error: undefined }
        : { id: crypto.randomUUID(), target: { ...target }, text: (text ?? draft.text).trim(), images: [...draft.images], options };
      if (!request.text && request.images.length === 0) return null;
      update(key, {
        ...draft,
        ...(retry ? {} : { text: '', images: [] }),
        failed: draft.failed.filter((entry) => entry.id !== retryId),
        pending: request,
      });
      return request;
    },
    bindRecipient: (key, requestId, recipientId) => {
      const draft = get().drafts[key];
      if (draft?.pending?.id !== requestId) return key;
      const target = { ...draft.pending.target, recipientId };
      const nextKey = agentComposerKey(target);
      const existing = get().drafts[nextKey];
      update(nextKey, {
        ...draft,
        text: [existing?.text, draft.text].filter(Boolean).join('\n'),
        images: [...(existing?.images ?? []), ...draft.images],
        failed: [...(existing?.failed ?? []), ...draft.failed],
        pending: { ...draft.pending, target },
      });
      update(key, { ...EMPTY, loaded: true });
      return nextKey;
    },
    finish: (key, requestId, error, requiresVerification = false) => {
      const draft = get().drafts[key];
      if (draft?.pending?.id !== requestId) return;
      update(key, {
        ...draft, pending: undefined,
        failed: error === undefined ? draft.failed : [...draft.failed, {
          ...draft.pending, error: error instanceof Error ? error.message : String(error),
          requiresVerification,
        }],
      });
    },
  };
});

export function useAgentComposerDraft(target: AgentComposerTarget): { key: string; draft: ComposerDraft } {
  const key = agentComposerKey(target);
  const draft = useAgentComposerDrafts((state) => state.drafts[key] ?? EMPTY);
  useEffect(() => { void useAgentComposerDrafts.getState().load(key); }, [key]);
  return { key, draft };
}
