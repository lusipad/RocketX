import type { RcPreferences } from './types';

export interface RocketChatPreferencesDomain {
  getPreferences(): Promise<RcPreferences>;
  getExplicitPreferences(): Promise<RcPreferences>;
  setPreferences(data: Partial<RcPreferences>): Promise<void>;
}

export type RocketChatPreferencesSource = Partial<RocketChatPreferencesDomain>;

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
