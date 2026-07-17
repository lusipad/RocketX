import { useSyncExternalStore } from 'react';
import { EXTENSION_POINTS, type ContributionFor, type ExtensionPoint } from './types';

type Listener = () => void;

function contributionKey(point: ExtensionPoint, contribution: { id: string }): string {
  return point === 'composer.command'
    ? `${point}:${String((contribution as { name?: string }).name ?? contribution.id).toLowerCase()}`
    : `${point}:${contribution.id}`;
}

export class KernelRegistry {
  private entries = new Map<ExtensionPoint, Map<string, { appId: string; contribution: { id: string } }>>(
    EXTENSION_POINTS.map((point) => [point, new Map()]),
  );
  private listeners = new Set<Listener>();
  private version = 0;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): number => this.version;

  get<P extends ExtensionPoint>(point: P): readonly ContributionFor<P>[] {
    return [...(this.entries.get(point)?.values() ?? [])].map(
      (entry) => entry.contribution as ContributionFor<P>,
    );
  }

  ownerOf<P extends ExtensionPoint>(point: P, contribution: ContributionFor<P>): string | undefined {
    return this.entries.get(point)?.get(contributionKey(point, contribution))?.appId;
  }

  register<P extends ExtensionPoint>(
    appId: string,
    point: P,
    contribution: ContributionFor<P>,
  ): () => void {
    if (!appId.trim()) throw new Error('appId 不能为空');
    if (!contribution.id?.trim()) throw new Error(`${point} contribution.id 不能为空`);
    const bucket = this.entries.get(point)!;
    const key = contributionKey(point, contribution);
    const existing = bucket.get(key);
    if (existing) {
      throw new Error(`${key} 已由 ${existing.appId} 注册`);
    }
    bucket.set(key, { appId, contribution });
    this.changed();
    return () => {
      const current = bucket.get(key);
      if (current?.appId === appId) {
        bucket.delete(key);
        this.changed();
      }
    };
  }

  unregisterApp(appId: string): void {
    let changed = false;
    for (const bucket of this.entries.values()) {
      for (const [key, entry] of bucket) {
        if (entry.appId === appId) {
          bucket.delete(key);
          changed = true;
        }
      }
    }
    if (changed) this.changed();
  }

  clear(): void {
    for (const bucket of this.entries.values()) bucket.clear();
    this.changed();
  }

  private changed(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

export const kernelRegistry = new KernelRegistry();

/** 注册表是外部可变源，组件必须通过稳定快照订阅，不能在 selector 里临时造数组。 */
export function useKernelContributions<P extends ExtensionPoint>(
  point: P,
): readonly ContributionFor<P>[] {
  useSyncExternalStore(kernelRegistry.subscribe, kernelRegistry.getSnapshot, kernelRegistry.getSnapshot);
  return kernelRegistry.get(point);
}
