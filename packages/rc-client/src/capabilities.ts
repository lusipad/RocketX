export type RocketChatCapabilityName =
  | 'threads'
  | 'teams'
  | 'files'
  | 'readReceipts'
  | 'explicitPreferences'
  | 'ddp'
  | 'search'
  | 'admin';

export interface RocketChatEndpointCapabilities {
  restBasePath: string;
  realtimePath: string;
  uploadPath: string;
}

export interface RocketChatAuthenticationCapabilities {
  password: boolean;
  resumeToken: boolean;
  customHeaders: boolean;
}

export interface RocketChatFileCapabilities {
  upload: boolean;
  download: boolean;
  maxUploadBytes: number;
  followsRedirects: boolean;
}

export interface RocketChatRealtimeCapabilities {
  ddp: boolean;
  websocket: boolean;
  protocol: 'ddp-v1' | 'unknown';
}

export interface RocketChatSettingsCapabilities {
  explicitPreferences: boolean;
  customPreferences: boolean;
}

export interface RocketChatCapabilities {
  apiVersion: string;
  serverVersion: string | null;
  endpoint: RocketChatEndpointCapabilities;
  authentication: RocketChatAuthenticationCapabilities;
  fileTransfer: RocketChatFileCapabilities;
  realtime: RocketChatRealtimeCapabilities;
  settings: RocketChatSettingsCapabilities;
  features: Readonly<Record<RocketChatCapabilityName, boolean>>;
  source: 'default' | 'server';
  updatedAt: number;
}

const DEFAULT_FEATURES: Record<RocketChatCapabilityName, boolean> = {
  threads: true,
  teams: true,
  files: true,
  readReceipts: true,
  explicitPreferences: true,
  ddp: true,
  search: true,
  admin: true,
};

const DEFAULT_ENDPOINT: RocketChatEndpointCapabilities = {
  restBasePath: '/api/v1',
  realtimePath: '/websocket',
  uploadPath: '/api/v1/rooms.media',
};

const DEFAULT_AUTHENTICATION: RocketChatAuthenticationCapabilities = {
  password: true,
  resumeToken: true,
  customHeaders: true,
};

const DEFAULT_FILE_TRANSFER: RocketChatFileCapabilities = {
  upload: true,
  download: true,
  maxUploadBytes: 10 * 1024 * 1024,
  followsRedirects: true,
};

const DEFAULT_REALTIME: RocketChatRealtimeCapabilities = {
  ddp: true,
  websocket: true,
  protocol: 'ddp-v1',
};

const DEFAULT_SETTINGS: RocketChatSettingsCapabilities = {
  explicitPreferences: true,
  customPreferences: true,
};

export function createRocketChatCapabilities(
  input: Partial<RocketChatCapabilities> = {},
): RocketChatCapabilities {
  return {
    apiVersion: input.apiVersion?.trim() || 'v1',
    serverVersion: input.serverVersion?.trim() || null,
    endpoint: { ...DEFAULT_ENDPOINT, ...(input.endpoint ?? {}) },
    authentication: { ...DEFAULT_AUTHENTICATION, ...(input.authentication ?? {}) },
    fileTransfer: { ...DEFAULT_FILE_TRANSFER, ...(input.fileTransfer ?? {}) },
    realtime: { ...DEFAULT_REALTIME, ...(input.realtime ?? {}) },
    settings: { ...DEFAULT_SETTINGS, ...(input.settings ?? {}) },
    features: { ...DEFAULT_FEATURES, ...(input.features ?? {}) },
    source: input.source ?? 'default',
    updatedAt: input.updatedAt ?? Date.now(),
  };
}

export function capabilityEnabled(
  capabilities: RocketChatCapabilities,
  name: RocketChatCapabilityName,
): boolean {
  return capabilities.features[name] === true;
}
