import type { RcMessage, RcPreferences, RcRoom, RcRoomFile, RcRoomRole, RcSubscription, RcTeam, RcUser, RoomType } from './types';
import { createRocketChatCapabilities, type RocketChatCapabilities } from './capabilities';
import {
  createRocketChatAuthDomain,
  type RocketChatAuthDomain,
  type RocketChatAuthSource,
} from './auth';
import {
  createRocketChatFilesDomain,
  type RocketChatFilesDomain,
  type RocketChatFilesSource,
} from './files';
import {
  createRocketChatMessagesDomain,
  type RocketChatMessagesDomain,
  type RocketChatMessagesSource,
} from './messages';
import {
  createRocketChatPreferencesDomain,
  type RocketChatPreferencesDomain,
  type RocketChatPreferencesSource,
} from './preferences';
import {
  createRocketChatRoomsDomain,
  type RocketChatRoomsDomain,
  type RocketChatRoomsSource,
} from './rooms';
import {
  createRocketChatSearchDomain,
  type RocketChatSearchDomain,
  type RocketChatSearchSource,
} from './search';
import {
  createRocketChatUsersDomain,
  type RocketChatUsersDomain,
  type RocketChatUsersSource,
} from './users';
import {
  createRocketChatRealtimeGateway,
  type RocketChatRealtimeGateway,
} from './realtimeGateway';

/** 兼容旧调用方的窄领域合同。 */
export type RocketChatMessagingApi = RocketChatMessagesDomain;
export type RocketChatRoomDirectoryApi = Pick<RocketChatRoomsDomain, 'getSubscriptions' | 'getRooms' | 'getMembers'>;
export type RocketChatPreferencesApi = RocketChatPreferencesDomain;
export type RocketChatFileApi = Pick<RocketChatFilesDomain, 'getRoomFiles' | 'fetchFile'>;

export interface RocketChatDomainFacades {
  auth: RocketChatAuthDomain;
  users: RocketChatUsersDomain;
  messaging: RocketChatMessagingApi;
  rooms: RocketChatRoomsDomain;
  preferences: RocketChatPreferencesApi;
  files: RocketChatFilesDomain;
  search: RocketChatSearchDomain;
  realtime: RocketChatRealtimeGateway;
}

/**
 * 领域 facade 是防腐层：参数校验、分页上限和兼容分支在这里收口，
 * Store 不再直接依赖 REST class 的四十多个端点。
 */
export type RocketChatDomainSource = RocketChatAuthSource
  & RocketChatUsersSource
  & RocketChatMessagesSource
  & RocketChatRoomsSource
  & RocketChatPreferencesSource
  & RocketChatFilesSource
  & RocketChatSearchSource
  & {
    baseUrl?: string;
    capabilities?: RocketChatCapabilities;
  };

export function createRocketChatDomainFacades(source: RocketChatDomainSource): RocketChatDomainFacades {
  return {
    auth: createRocketChatAuthDomain(source),
    users: createRocketChatUsersDomain(source),
    messaging: createRocketChatMessagesDomain(source),
    rooms: createRocketChatRoomsDomain(source),
    preferences: createRocketChatPreferencesDomain(source),
    files: createRocketChatFilesDomain(source),
    search: createRocketChatSearchDomain(source),
    realtime: createRocketChatRealtimeGateway(
      source.baseUrl ?? '',
      source.capabilities ?? createRocketChatCapabilities(),
    ),
  };
}

// 保留这些类型导出，避免旧的类型导入路径产生破坏性变化。
export type {
  RcMessage,
  RcPreferences,
  RcRoom,
  RcRoomFile,
  RcRoomRole,
  RcSubscription,
  RcTeam,
  RcUser,
  RoomType,
};
