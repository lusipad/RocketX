import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { t } from '../../i18n';
import type { CodexProcessInfo, CodexTransport, CodexTransportHandlers } from './client';

interface OutputEvent {
  processId: string;
  stream: 'stdout' | 'stderr';
  line: string;
}

interface ExitEvent {
  processId: string;
  code: number | null;
  reason?: string;
}

export class TauriPiTransport implements CodexTransport {
  private processId: string | null = null;
  private unlisten: UnlistenFn[] = [];
  private generation = 0;

  constructor(
    private readonly sessionId: string,
    private readonly workspaceRoot: string,
  ) {}

  async start(handlers: CodexTransportHandlers): Promise<CodexProcessInfo> {
    const generation = ++this.generation;
    const listeners: UnlistenFn[] = [];
    this.unlisten = listeners;
    const keepListener = (unlisten: UnlistenFn) => {
      if (generation !== this.generation) {
        unlisten();
        throw new Error(t('agent.transport.piCanceled'));
      }
      listeners.push(unlisten);
    };
    try {
      keepListener(await listen<OutputEvent>('pi-app-server-output', (event) => {
        if (generation !== this.generation || event.payload.processId !== this.processId) return;
        if (event.payload.stream === 'stdout') handlers.onLine(event.payload.line);
      }));
      keepListener(await listen<ExitEvent>('pi-app-server-exit', (event) => {
        if (generation === this.generation && event.payload.processId === this.processId) {
          const { code, reason } = event.payload;
          const codeSuffix = code === null ? '' : t('agent.transport.piExitCodePart', { code });
          const errorDetail = reason
            ? t('agent.transport.piExitedWithReason', { code: code ?? t('agent.acpClient.unknownCode'), reason })
            : t('agent.transport.piExited', { codePart: codeSuffix });
          handlers.onExit(code, errorDetail);
        }
      }));
      const process = await invoke<CodexProcessInfo>('pi_app_server_start', {
        sessionId: this.sessionId,
        workspaceRoot: this.workspaceRoot,
      });
      if (generation !== this.generation) {
        void invoke('pi_app_server_stop', { processId: process.processId }).catch(() => undefined);
        throw new Error(t('agent.transport.piCanceled'));
      }
      this.processId = process.processId;
      return process;
    } catch (error) {
      for (const unlisten of listeners.splice(0)) unlisten();
      throw error;
    }
  }

  async write(message: Record<string, unknown>): Promise<void> {
    if (!this.processId) throw new Error(t('agent.transport.piNotActive'));
    await invoke('pi_app_server_write', { processId: this.processId, message });
  }

  async stop(): Promise<void> {
    this.generation += 1;
    const processId = this.processId;
    this.processId = null;
    this.clearListeners();
    if (processId) await invoke('pi_app_server_stop', { processId });
  }

  private clearListeners(): void {
    for (const unlisten of this.unlisten.splice(0)) unlisten();
  }
}
