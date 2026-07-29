import { create } from 'zustand';
import type { ButlerLine } from './butler';
import type { ButlerSource } from '../lib/butlerContext';

const ARTIFACTS_KEY = 'rcx-butler-artifacts';
const ARTIFACT_LIMIT = 50;
const VERSION_LIMIT = 20;
const LONG_RESULT_THRESHOLD = 480;

export type ButlerArtifactKind = 'report' | 'draft' | 'diff' | 'checklist';
export type ButlerArtifactStatus = 'working' | 'accepted' | 'superseded';

export interface ButlerArtifactVersion {
  id: string;
  number: number;
  content: string;
  sources: ButlerSource[];
  createdAt: number;
}

export interface ButlerArtifact {
  id: string;
  sessionId?: string;
  sourceLineId: string;
  title: string;
  kind: ButlerArtifactKind;
  status: ButlerArtifactStatus;
  createdAt: number;
  updatedAt: number;
  versions: ButlerArtifactVersion[];
}

interface ButlerArtifactState {
  artifacts: ButlerArtifact[];
  hydrated: boolean;
  hydrate: () => void;
  captureLine: (sessionId: string, line: ButlerLine) => ButlerArtifact | undefined;
  revise: (id: string, content: string, sources?: ButlerSource[]) => void;
  accept: (id: string) => void;
}

function artifactTitle(text: string): string {
  const first = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:#{1,6}|[-*+]|\d+\.)\s*/, '').replace(/[*_`]/g, '').trim())
    .find(Boolean);
  if (!first) return '管家成果';
  return first.length > 56 ? `${first.slice(0, 55)}…` : first;
}

function artifactKind(text: string): ButlerArtifactKind {
  if (/```diff|^\s*(?:diff --git|@@ )/m.test(text)) return 'diff';
  if (/^\s*[-*]\s+\[[ xX]\]/m.test(text)) return 'checklist';
  if (/草稿|拟定|draft/i.test(text)) return 'draft';
  return 'report';
}

export function shouldCaptureButlerArtifact(line: ButlerLine): boolean {
  if (line.role !== 'assistant') return false;
  return line.text.trim().length >= LONG_RESULT_THRESHOLD
    || /```(?:diff|patch)|^\s*[-*]\s+\[[ xX]\]/m.test(line.text);
}

export function butlerArtifactsForSession(
  artifacts: readonly ButlerArtifact[],
  sessionId: string,
  lines: readonly ButlerLine[],
): ButlerArtifact[] {
  const sourceLineIds = new Set(lines.map((line) => line.id));
  return artifacts.filter((artifact) => (
    artifact.sessionId
      ? artifact.sessionId === sessionId
      : sourceLineIds.has(artifact.sourceLineId)
  ));
}

function normalizeArtifacts(value: unknown): ButlerArtifact[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const item = candidate as Partial<ButlerArtifact>;
    if (
      typeof item.id !== 'string'
      || typeof item.sourceLineId !== 'string'
      || typeof item.title !== 'string'
      || !['report', 'draft', 'diff', 'checklist'].includes(item.kind ?? '')
      || !['working', 'accepted', 'superseded'].includes(item.status ?? '')
      || typeof item.createdAt !== 'number'
      || typeof item.updatedAt !== 'number'
      || !Array.isArray(item.versions)
    ) return [];
    const versions = item.versions.flatMap((version) => (
      version
      && typeof version === 'object'
      && typeof (version as ButlerArtifactVersion).id === 'string'
      && typeof (version as ButlerArtifactVersion).number === 'number'
      && typeof (version as ButlerArtifactVersion).content === 'string'
      && typeof (version as ButlerArtifactVersion).createdAt === 'number'
        ? [{
          ...(version as ButlerArtifactVersion),
          sources: Array.isArray((version as ButlerArtifactVersion).sources)
            ? (version as ButlerArtifactVersion).sources
            : [],
        }]
        : []
    )).slice(-VERSION_LIMIT);
    const sessionId = typeof item.sessionId === 'string' && item.sessionId.trim()
      ? item.sessionId.trim()
      : undefined;
    return versions.length ? [{
      ...item,
      sessionId,
      versions,
    } as ButlerArtifact] : [];
  }).slice(0, ARTIFACT_LIMIT);
}

function readArtifacts(): ButlerArtifact[] {
  try {
    const raw = localStorage.getItem(ARTIFACTS_KEY);
    return raw ? normalizeArtifacts(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function persist(artifacts: ButlerArtifact[]): void {
  try {
    localStorage.setItem(ARTIFACTS_KEY, JSON.stringify(artifacts.slice(0, ARTIFACT_LIMIT)));
  } catch {
    // 成果仍保留在当前会话内；存储不可用不能打断对话。
  }
}

export const useButlerArtifacts = create<ButlerArtifactState>((set, get) => ({
  artifacts: [],
  hydrated: false,

  hydrate: () => {
    if (get().hydrated) return;
    set({ artifacts: readArtifacts(), hydrated: true });
  },

  captureLine: (sessionId, line) => {
    if (!shouldCaptureButlerArtifact(line)) return undefined;
    const existing = get().artifacts.find((artifact) => (
      artifact.sourceLineId === line.id
      && (!artifact.sessionId || artifact.sessionId === sessionId)
    ));
    if (existing) return existing;
    const now = Date.now();
    const artifact: ButlerArtifact = {
      id: `artifact-${sessionId}-${line.id}`,
      sessionId,
      sourceLineId: line.id,
      title: artifactTitle(line.text),
      kind: artifactKind(line.text),
      status: 'working',
      createdAt: now,
      updatedAt: now,
      versions: [{
        id: `artifact-version-${line.id}`,
        number: 1,
        content: line.text,
        sources: line.sources ?? [],
        createdAt: now,
      }],
    };
    const artifacts = [artifact, ...get().artifacts].slice(0, ARTIFACT_LIMIT);
    set({ artifacts });
    persist(artifacts);
    return artifact;
  },

  revise: (id, content, sources = []) => {
    const text = content.trim();
    if (!text) return;
    const now = Date.now();
    const artifacts = get().artifacts.map((artifact) => {
      if (artifact.id !== id) return artifact;
      const number = (artifact.versions.at(-1)?.number ?? 0) + 1;
      return {
        ...artifact,
        status: 'working' as const,
        updatedAt: now,
        versions: [...artifact.versions, {
          id: `artifact-version-${crypto.randomUUID()}`,
          number,
          content: text,
          sources,
          createdAt: now,
        }].slice(-VERSION_LIMIT),
      };
    });
    set({ artifacts });
    persist(artifacts);
  },

  accept: (id) => {
    const artifacts = get().artifacts.map((artifact) => (
      artifact.id === id
        ? { ...artifact, status: 'accepted' as const, updatedAt: Date.now() }
        : artifact
    ));
    set({ artifacts });
    persist(artifacts);
  },
}));
