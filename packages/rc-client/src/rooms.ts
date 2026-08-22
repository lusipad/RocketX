import type { RcRoom, RcRoomRole, RcSubscription, RcTeam, RcUser, RoomType } from './types';

export interface RocketChatRoomsDomain {
  getSubscriptions(): Promise<RcSubscription[]>;
  getRooms(): Promise<RcRoom[]>;
  getMembers(rid: string, type: RoomType, count?: number): Promise<RcUser[]>;
  listTeams(count?: number): Promise<RcTeam[]>;
  listTeamRooms(teamId: string, count?: number): Promise<RcRoom[]>;
  createDirectMessage(usernames: string | string[]): Promise<RcRoom>;
  createGroup(name: string, members: string[], priv?: boolean): Promise<RcRoom>;
  getRoomInfo(rid: string): Promise<RcRoom>;
  getRoomRoles(rid: string, type: RoomType): Promise<RcRoomRole[]>;
  favoriteRoom(roomId: string, favorite: boolean): Promise<unknown>;
  muteRoom(roomId: string, mute: boolean): Promise<unknown>;
  hideRoom(roomId: string, type: RoomType): Promise<unknown>;
  openRoom(roomId: string, type: RoomType): Promise<unknown>;
}

export type RocketChatRoomsSource = Partial<RocketChatRoomsDomain>;

function required<K extends keyof RocketChatRoomsDomain>(source: RocketChatRoomsSource, key: K): NonNullable<RocketChatRoomsDomain[K]> {
  const operation = source[key];
  if (typeof operation !== 'function') throw new Error(`Rocket.Chat rooms domain unavailable: ${String(key)}`);
  return operation.bind(source) as NonNullable<RocketChatRoomsDomain[K]>;
}

function requiredId(value: string, field: string): string {
  if (!value.trim()) throw new Error(`${field} 不能为空`);
  return value;
}

export function createRocketChatRoomsDomain(source: RocketChatRoomsSource): RocketChatRoomsDomain {
  return {
    getSubscriptions: () => required(source, 'getSubscriptions')(),
    getRooms: () => required(source, 'getRooms')(),
    getMembers: (rid, type, count) => required(source, 'getMembers')(requiredId(rid, 'roomId'), type, Math.max(1, count ?? 200)),
    listTeams: (count) => required(source, 'listTeams')(Math.max(1, count ?? 50)),
    listTeamRooms: (teamId, count) => required(source, 'listTeamRooms')(requiredId(teamId, 'teamId'), Math.max(1, count ?? 50)),
    createDirectMessage: (usernames) => required(source, 'createDirectMessage')(usernames),
    createGroup: (name, members, priv) => required(source, 'createGroup')(requiredId(name, 'name'), members, priv),
    getRoomInfo: (rid) => required(source, 'getRoomInfo')(requiredId(rid, 'roomId')),
    getRoomRoles: (rid, type) => required(source, 'getRoomRoles')(requiredId(rid, 'roomId'), type),
    favoriteRoom: (roomId, favorite) => required(source, 'favoriteRoom')(requiredId(roomId, 'roomId'), favorite),
    muteRoom: (roomId, mute) => required(source, 'muteRoom')(requiredId(roomId, 'roomId'), mute),
    hideRoom: (roomId, type) => required(source, 'hideRoom')(requiredId(roomId, 'roomId'), type),
    openRoom: (roomId, type) => required(source, 'openRoom')(requiredId(roomId, 'roomId'), type),
  };
}
