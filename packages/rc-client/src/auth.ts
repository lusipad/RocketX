import type { RcLoginData, RcUser } from './types';

export interface RocketChatAuthDomain {
  login(user: string, password: string): Promise<RcLoginData>;
  loginWithToken(token: string): Promise<RcLoginData>;
  logout(): Promise<void>;
  me(): Promise<RcUser>;
}

export interface RocketChatAuthSource {
  login?: (user: string, password: string) => Promise<RcLoginData>;
  loginWithToken?: (token: string) => Promise<RcLoginData>;
  logout?: () => Promise<void>;
  me?: () => Promise<RcUser>;
}

function unavailable(operation: string): never {
  throw new Error(`Rocket.Chat auth domain unavailable: ${operation}`);
}

export function createRocketChatAuthDomain(source: RocketChatAuthSource): RocketChatAuthDomain {
  return {
    login: (user, password) => source.login?.(user, password) ?? unavailable('login'),
    loginWithToken: (token) => source.loginWithToken?.(token) ?? unavailable('loginWithToken'),
    logout: () => source.logout?.() ?? unavailable('logout'),
    me: () => source.me?.() ?? unavailable('me'),
  };
}
