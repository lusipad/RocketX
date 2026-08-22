import type { RcRoomFile, RoomType } from './types';
import { capabilityEnabled, type RocketChatCapabilities } from './capabilities';

export interface RocketChatFilesDomain {
  getRoomFiles(rid: string, type: RoomType, count?: number): Promise<RcRoomFile[]>;
  fetchFile(path: string): Promise<Blob>;
  fetchFileResponse(path: string): Promise<Response>;
}

export type RocketChatFilesSource = Partial<RocketChatFilesDomain> & {
  capabilities?: RocketChatCapabilities;
};

function required<K extends keyof RocketChatFilesDomain>(source: RocketChatFilesSource, key: K): NonNullable<RocketChatFilesDomain[K]> {
  const operation = source[key];
  if (typeof operation !== 'function') throw new Error(`Rocket.Chat files domain unavailable: ${String(key)}`);
  return operation.bind(source) as NonNullable<RocketChatFilesDomain[K]>;
}

export function createRocketChatFilesDomain(source: RocketChatFilesSource): RocketChatFilesDomain {
  const ensureDownload = () => {
    if (source.capabilities && !capabilityEnabled(source.capabilities, 'files')) {
      throw new Error('Rocket.Chat server does not advertise file transfer capability');
    }
  };
  return {
    getRoomFiles: (rid, type, count) => {
      ensureDownload();
      return required(source, 'getRoomFiles')(rid, type, Math.max(1, count ?? 50));
    },
    fetchFile: (path) => {
      ensureDownload();
      return required(source, 'fetchFile')(path);
    },
    fetchFileResponse: (path) => {
      ensureDownload();
      return required(source, 'fetchFileResponse')(path);
    },
  };
}
