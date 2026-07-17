import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { CodexProcessInfo, CodexTransport, CodexTransportHandlers } from './client';

interface OutputEvent {
  processId: string;
  stream: 'stdout' | 'stderr';
  line: string;
}

interface ExitEvent {
  processId: string;
  code: number | null;
}

export class TauriCodexTransport implements CodexTransport {
  private processId: string | null = null;
  private unlisten: UnlistenFn[] = [];

  async start(handlers: CodexTransportHandlers): Promise<CodexProcessInfo> {
    const output = await listen<OutputEvent>('codex-app-server-output', (event) => {
      if (event.payload.processId !== this.processId) return;
      if (event.payload.stream === 'stdout') handlers.onLine(event.payload.line);
    });
    const exit = await listen<ExitEvent>('codex-app-server-exit', (event) => {
      if (event.payload.processId === this.processId) handlers.onExit(event.payload.code);
    });
    this.unlisten.push(output, exit);
    try {
      const process = await invoke<CodexProcessInfo>('codex_app_server_start');
      this.processId = process.processId;
      return process;
    } catch (error) {
      this.clearListeners();
      throw error;
    }
  }

  async write(message: Record<string, unknown>): Promise<void> {
    if (!this.processId) throw new Error('Codex app-server process is not active');
    await invoke('codex_app_server_write', { processId: this.processId, message });
  }

  async stop(): Promise<void> {
    const processId = this.processId;
    this.processId = null;
    this.clearListeners();
    if (processId) await invoke('codex_app_server_stop', { processId });
  }

  private clearListeners(): void {
    for (const unlisten of this.unlisten.splice(0)) unlisten();
  }
}
