import type { RocketChatCapabilities } from './capabilities';

export interface RocketChatRealtimeGateway {
  readonly supportsDdp: boolean;
  readonly protocol: RocketChatCapabilities['realtime']['protocol'];
  websocketUrl(): string;
}

export function createRocketChatRealtimeGateway(
  baseUrl: string,
  capabilities: RocketChatCapabilities,
): RocketChatRealtimeGateway {
  const normalized = baseUrl.replace(/\/+$/, '');
  return {
    supportsDdp: capabilities.realtime.ddp,
    protocol: capabilities.realtime.protocol,
    websocketUrl: () => {
      if (!normalized) return capabilities.endpoint.realtimePath;
      const wsBase = normalized.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
      return `${wsBase}${capabilities.endpoint.realtimePath}`;
    },
  };
}
