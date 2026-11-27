import { create } from 'zustand';
import { resolveButlerAccountScope } from './butlerMemory';

export type ButlerRoomBindingTargetKind = 'acp_session' | 'watchpoint';

export interface ButlerRoomBinding {
  id: string;
  targetKind: ButlerRoomBindingTargetKind;
  targetId: string;
  label: string;
  rid: string;
  roomName: string;
  tmid?: string;
  autoPost: boolean;
  enabled: boolean;
  createdAt: number;
  lastReportedKey?: string;
}

export interface BindToRoomInput {
  targetKind: ButlerRoomBindingTargetKind;
  targetId: string;
  label: string;
  rid: string;
  roomName: string;
  tmid?: string;
  autoPost?: boolean;
}

const STORAGE_PREFIX = 'rcx-butler-room-bindings:v1:';
const MAX_BINDINGS = 80;

function storageKey(scope: string): string {
  return `${STORAGE_PREFIX}${scope || 'default'}`;
}

function readPersisted(scope: string): ButlerRoomBinding[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(storageKey(scope));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ButlerRoomBinding[]).slice(0, MAX_BINDINGS) : [];
  } catch {
    return [];
  }
}

function writePersisted(scope: string, bindings: ButlerRoomBinding[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(storageKey(scope), JSON.stringify(bindings.slice(0, MAX_BINDINGS)));
  } catch {
    /* ignore storage quota failures */
  }
}

interface ButlerRoomBindingsState {
  accountScope: string;
  hydrated: boolean;
  bindings: ButlerRoomBinding[];
  hydrate: (force?: boolean) => void;
  bindToRoom: (input: BindToRoomInput) => ButlerRoomBinding;
  unbind: (id: string) => void;
  toggleAutoPost: (id: string) => void;
  markReported: (id: string, reportKey: string) => void;
  getBindingsForRoom: (rid: string) => ButlerRoomBinding[];
  getBindingsForTarget: (
    targetKind: ButlerRoomBindingTargetKind,
    targetId: string,
  ) => ButlerRoomBinding[];
}

export const useButlerRoomBindings = create<ButlerRoomBindingsState>((set, get) => ({
  accountScope: 'default',
  hydrated: false,
  bindings: [],

  hydrate: (force = false) => {
    const scope = resolveButlerAccountScope();
    if (!force && get().hydrated && get().accountScope === scope) return;
    set({
      accountScope: scope,
      hydrated: true,
      bindings: readPersisted(scope),
    });
  },

  bindToRoom: (input) => {
    get().hydrate();
    const scope = get().accountScope;
    const now = Date.now();
    const existing = get().bindings.find(
      (b) =>
        b.targetKind === input.targetKind
        && b.targetId === input.targetId
        && b.rid === input.rid
        && (b.tmid ?? '') === (input.tmid ?? ''),
    );
    if (existing) {
      const updated: ButlerRoomBinding = {
        ...existing,
        label: input.label.trim() || existing.label,
        roomName: input.roomName.trim() || existing.roomName,
        autoPost: input.autoPost ?? existing.autoPost,
        enabled: true,
      };
      const next = [updated, ...get().bindings.filter((b) => b.id !== existing.id)];
      set({ bindings: next });
      writePersisted(scope, next);
      return updated;
    }

    const created: ButlerRoomBinding = {
      id: `rb-${crypto.randomUUID().slice(0, 8)}`,
      targetKind: input.targetKind,
      targetId: input.targetId,
      label: input.label.trim() || input.targetId,
      rid: input.rid,
      roomName: input.roomName.trim() || input.rid,
      ...(input.tmid ? { tmid: input.tmid } : {}),
      autoPost: input.autoPost ?? true,
      enabled: true,
      createdAt: now,
    };
    const next = [created, ...get().bindings].slice(0, MAX_BINDINGS);
    set({ bindings: next });
    writePersisted(scope, next);
    return created;
  },

  unbind: (id) => {
    get().hydrate();
    const next = get().bindings.filter((b) => b.id !== id);
    set({ bindings: next });
    writePersisted(get().accountScope, next);
  },

  toggleAutoPost: (id) => {
    get().hydrate();
    const next = get().bindings.map((b) =>
      b.id === id ? { ...b, autoPost: !b.autoPost } : b,
    );
    set({ bindings: next });
    writePersisted(get().accountScope, next);
  },

  markReported: (id, reportKey) => {
    get().hydrate();
    const next = get().bindings.map((b) =>
      b.id === id ? { ...b, lastReportedKey: reportKey } : b,
    );
    set({ bindings: next });
    writePersisted(get().accountScope, next);
  },

  getBindingsForRoom: (rid) => {
    get().hydrate();
    return get().bindings.filter((b) => b.enabled && b.rid === rid);
  },

  getBindingsForTarget: (targetKind, targetId) => {
    get().hydrate();
    return get().bindings.filter(
      (b) => b.enabled && b.targetKind === targetKind && b.targetId === targetId,
    );
  },
}));
