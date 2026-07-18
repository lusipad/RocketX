import type {
  AiCapability,
  AiChatRequest,
  AiChunk,
  AiProvider,
  AiRoute,
} from './provider';

export interface AiAuditEntry {
  [key: string]: unknown;
  appId: 'rocketx.ai';
  action: 'ai.chat';
  allowed: boolean;
  capability: AiCapability;
  providerId: string;
  locality?: 'local' | 'external';
  model?: string;
  origin?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  durationMs: number;
  reason?: string;
}

type AuditWriter = (entry: AiAuditEntry) => void | Promise<void>;

export class AiBus {
  private readonly providers = new Map<string, AiProvider>();
  private readonly routes = new Map<AiCapability, AiRoute>();

  constructor(private readonly writeAudit: AuditWriter) {}

  register(provider: AiProvider): () => void {
    if (this.providers.has(provider.id)) throw new Error(`AI Provider 已存在: ${provider.id}`);
    this.providers.set(provider.id, provider);
    return () => this.providers.delete(provider.id);
  }

  setRoute(capability: AiCapability, route: AiRoute): void {
    this.routes.set(capability, route);
  }

  async *chat(capability: AiCapability, request: AiChatRequest): AsyncGenerator<AiChunk> {
    const route = this.routes.get(capability);
    if (!route) {
      yield* this.chatProvider('unconfigured', capability, request, false);
      return;
    }
    yield* this.chatProvider(route.providerId, capability, request, route.localOnly);
  }

  async *chatProvider(
    providerId: string,
    capability: AiCapability,
    request: AiChatRequest,
    localOnly: boolean,
  ): AsyncGenerator<AiChunk> {
    const startedAt = Date.now();
    let provider: AiProvider | undefined;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let totalTokens: number | undefined;
    try {
      provider = this.providers.get(providerId);
      if (!provider) throw new Error(`AI Provider 不存在: ${providerId}`);
      if (localOnly && provider.locality !== 'local') {
        throw new Error(`能力 ${capability} 仅允许本地模型`);
      }
      for await (const chunk of provider.chat(request)) {
        promptTokens = chunk.usage?.promptTokens ?? promptTokens;
        completionTokens = chunk.usage?.completionTokens ?? completionTokens;
        totalTokens = chunk.usage?.totalTokens ?? totalTokens;
        yield chunk;
      }
      totalTokens ??=
        promptTokens !== undefined && completionTokens !== undefined
          ? promptTokens + completionTokens
          : undefined;
      await this.writeAudit({
        appId: 'rocketx.ai',
        action: 'ai.chat',
        allowed: true,
        capability,
        providerId: provider.id,
        locality: provider.locality,
        model: provider.model,
        origin: provider.origin,
        promptTokens,
        completionTokens,
        totalTokens,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      await this.writeAudit({
        appId: 'rocketx.ai',
        action: 'ai.chat',
        allowed: false,
        capability,
        providerId: provider?.id ?? providerId,
        locality: provider?.locality,
        model: provider?.model,
        origin: provider?.origin,
        durationMs: Date.now() - startedAt,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

}
