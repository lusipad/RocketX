import type { RcLoginData, RcUser } from './types';
import type { RcRestEndpointContext } from './request';

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

export async function login(context: RcRestEndpointContext, user: string, password: string): Promise<RcLoginData> {
  const response = await context.request<{ data: RcLoginData }>('POST', 'login', { user, password });
  context.setAuth(response.data.authToken, response.data.userId);
  return response.data;
}

export async function loginWithToken(context: RcRestEndpointContext, token: string): Promise<RcLoginData> {
  const response = await context.request<{ data: RcLoginData }>('POST', 'login', { resume: token });
  context.setAuth(response.data.authToken, response.data.userId);
  return response.data;
}

export async function logout(context: RcRestEndpointContext): Promise<void> {
  try {
    await context.request('POST', 'logout');
  } finally {
    context.setAuth(null, null);
  }
}

export function me(context: RcRestEndpointContext): Promise<RcUser> {
  return context.request<RcUser>('GET', 'me');
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
