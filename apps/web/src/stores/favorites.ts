import { create } from 'zustand';

export type FavSize = 'small' | 'medium' | 'large';

export interface Favorite {
  id: string;
  title: string;
  url: string;
  icon?: string;
  color: string;
  size: FavSize;
  createdAt: number;
}

const KEY = 'rcx-favorites';

const COLORS = [
  '#3370ff', '#00b96b', '#7f3bf5', '#f54a45', '#ff8800',
  '#14b8a6', '#f472b6', '#8b5cf6', '#06b6d4', '#84cc16',
];

function load(): Favorite[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as Favorite[];
  } catch {
    return [];
  }
}

function persist(favs: Favorite[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(favs));
  } catch { /* quota */ }
}

function genId(): string {
  return `fav${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

export function randomFavColor(): string {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

export const SIZE_SPAN: Record<FavSize, string> = {
  small: 'col-span-1',
  medium: 'col-span-2',
  large: 'col-span-3',
};

export const SIZE_LABELS: Record<FavSize, string> = {
  small: '小',
  medium: '中',
  large: '大',
};

interface FavoritesState {
  items: Favorite[];
  add: (f: Omit<Favorite, 'id' | 'createdAt'>) => string;
  update: (id: string, patch: Partial<Omit<Favorite, 'id' | 'createdAt'>>) => void;
  remove: (id: string) => void;
  reorder: (fromIndex: number, toIndex: number) => void;
}

export const useFavorites = create<FavoritesState>((set, get) => ({
  items: load(),

  add: (f) => {
    const id = genId();
    const items = [...get().items, { ...f, id, createdAt: Date.now() }];
    set({ items });
    persist(items);
    return id;
  },

  update: (id, patch) => {
    const items = get().items.map((f) => (f.id === id ? { ...f, ...patch } : f));
    set({ items });
    persist(items);
  },

  remove: (id) => {
    const items = get().items.filter((f) => f.id !== id);
    set({ items });
    persist(items);
  },

  reorder: (fromIndex, toIndex) => {
    const items = [...get().items];
    const [moved] = items.splice(fromIndex, 1);
    items.splice(toIndex, 0, moved);
    set({ items });
    persist(items);
  },
}));
