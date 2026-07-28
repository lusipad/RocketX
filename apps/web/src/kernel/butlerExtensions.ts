export interface ButlerExtensionStateStore {
  read<T>(extensionId: string): T | undefined;
  write<T>(extensionId: string, state: T): void;
}

export interface ButlerExtensionManifest {
  id: string;
  version: string;
  requires?: readonly string[];
}

export interface ButlerExtensionContext {
  readonly extensionId: string;
  emit<T>(event: string, payload: T): void;
  on<T>(event: string, listener: (payload: T) => void): () => void;
  get<T>(extensionId: string): T;
  readState<T>(): T | undefined;
  writeState<T>(state: T): void;
}

export interface ButlerExtensionActivation<TApi> {
  api: TApi;
  dispose?: () => void;
}

export interface ButlerExtension<TApi = unknown> {
  manifest: ButlerExtensionManifest;
  activate(context: ButlerExtensionContext): ButlerExtensionActivation<TApi>;
}

interface LoadedExtension {
  api: unknown;
  dispose: () => void;
}

type EventListener = (payload: unknown) => void;

/**
 * Butler 的可信扩展宿主。
 *
 * 内核只负责依赖顺序、事件、命名空间状态和卸载。
 * 外部 App 的权限仍由既有 CapabilityBus 负责。
 */
export class ButlerExtensionHost {
  private readonly loaded = new Map<string, LoadedExtension>();
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(
    private readonly state: ButlerExtensionStateStore,
    private readonly onError: (extensionId: string, error: unknown) => void = () => undefined,
  ) {}

  load<TApi>(extension: ButlerExtension<TApi>): TApi {
    const { id, requires = [] } = extension.manifest;
    if (!id.trim()) throw new Error('Butler extension id 不能为空');
    if (this.loaded.has(id)) throw new Error(`Butler extension 已加载: ${id}`);
    const missing = requires.find((dependency) => !this.loaded.has(dependency));
    if (missing) throw new Error(`Butler extension ${id} 缺少依赖: ${missing}`);

    const cleanups: Array<() => void> = [];
    const context: ButlerExtensionContext = {
      extensionId: id,
      emit: (event, payload) => this.emit(event, payload),
      on: (event, listener) => {
        const cleanup = this.on(event, listener);
        cleanups.push(cleanup);
        return cleanup;
      },
      get: (extensionId) => this.get(extensionId),
      readState: () => this.state.read(id),
      writeState: (value) => this.state.write(id, value),
    };

    try {
      const activation = extension.activate(context);
      const dispose = () => {
        activation.dispose?.();
        for (const cleanup of cleanups.reverse()) cleanup();
      };
      this.loaded.set(id, { api: activation.api, dispose });
      return activation.api;
    } catch (error) {
      for (const cleanup of cleanups.reverse()) cleanup();
      this.onError(id, error);
      throw error;
    }
  }

  get<TApi>(extensionId: string): TApi {
    const extension = this.loaded.get(extensionId);
    if (!extension) throw new Error(`Butler extension 未加载: ${extensionId}`);
    return extension.api as TApi;
  }

  has(extensionId: string): boolean {
    return this.loaded.has(extensionId);
  }

  dispatch<T>(event: string, payload: T): void {
    this.emit(event, payload);
  }

  unload(extensionId: string): void {
    const extension = this.loaded.get(extensionId);
    if (!extension) return;
    extension.dispose();
    this.loaded.delete(extensionId);
  }

  dispose(): void {
    for (const extensionId of [...this.loaded.keys()].reverse()) this.unload(extensionId);
    this.listeners.clear();
  }

  private on<T>(event: string, listener: (payload: T) => void): () => void {
    const listeners = this.listeners.get(event) ?? new Set<EventListener>();
    const wrapped = listener as EventListener;
    listeners.add(wrapped);
    this.listeners.set(event, listeners);
    return () => {
      listeners.delete(wrapped);
      if (listeners.size === 0) this.listeners.delete(event);
    };
  }

  private emit<T>(event: string, payload: T): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        listener(payload);
      } catch (error) {
        this.onError('event-listener', error);
      }
    }
  }
}
