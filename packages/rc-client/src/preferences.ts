import type { RcPreferences } from './types';
import type { RcRestEndpointContext } from './request';

export interface RocketChatPreferencesDomain {
  getPreferences(): Promise<RcPreferences>;
  getExplicitPreferences(): Promise<RcPreferences>;
  setPreferences(data: Partial<RcPreferences>): Promise<void>;
}

export type RocketChatPreferencesSource = Partial<RocketChatPreferencesDomain>;

export async function getPreferences(context: RcRestEndpointContext): Promise<RcPreferences> {
  const response = await context.request<{ settings?: { preferences?: RcPreferences } }>('GET', 'me');
  return response.settings?.preferences ?? {};
}

export async function getExplicitPreferences(context: RcRestEndpointContext): Promise<RcPreferences> {
  const userId = context.currentUserId();
  if (!userId) return {};
  try {
    const response = await context.request<{ preferences?: RcPreferences }>(
      'GET',
      'users.getPreferences',
      undefined,
      { userId },
    );
    return response.preferences ?? {};
  } catch {
    const response = await context.request<{ user?: { settings?: { preferences?: RcPreferences } } }>(
      'GET',
      'users.info',
      undefined,
      { userId },
    );
    return response.user?.settings?.preferences ?? {};
  }
}

export async function setPreferences(
  context: RcRestEndpointContext,
  data: Partial<RcPreferences>,
): Promise<void> {
  const userId = context.currentUserId();
  if (!userId) throw new Error('未登录');
  await context.request('POST', 'users.setPreferences', { userId, data });
}

function required<K extends keyof RocketChatPreferencesDomain>(source: RocketChatPreferencesSource, key: K): NonNullable<RocketChatPreferencesDomain[K]> {
  const operation = source[key];
  if (typeof operation !== 'function') throw new Error(`Rocket.Chat preferences domain unavailable: ${String(key)}`);
  return operation.bind(source) as NonNullable<RocketChatPreferencesDomain[K]>;
}

export function createRocketChatPreferencesDomain(source: RocketChatPreferencesSource): RocketChatPreferencesDomain {
  return {
    getPreferences: () => required(source, 'getPreferences')(),
    getExplicitPreferences: () => required(source, 'getExplicitPreferences')(),
    setPreferences: (data) => required(source, 'setPreferences')(
      Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
    ),
  };
}
