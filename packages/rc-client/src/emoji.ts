import { postMultipart, type RcRestEndpointContext } from './request';

export interface RcCustomEmoji {
  name: string;
  aliases: string[];
}

type RcCustomEmojiPayload = {
  name?: unknown;
  aliases?: unknown;
};

function normalizeAliases(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  }
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

export async function getCustomEmojiByName(context: RcRestEndpointContext, name: string): Promise<RcCustomEmoji | null> {
  const response = await context.request<{ emojis?: RcCustomEmojiPayload[] }>('GET', 'emoji-custom.all', undefined, { name });
  const emoji = (response.emojis ?? []).find((item) => item?.name === name);
  if (!emoji || typeof emoji.name !== 'string') return null;
  return { name: emoji.name, aliases: normalizeAliases(emoji.aliases) };
}

export async function createCustomEmoji(
  context: RcRestEndpointContext,
  params: { name: string; file: Blob; fileName: string; aliases?: string[] },
): Promise<void> {
  await postMultipart(context, 'emoji-custom.create', 'emoji', params.file, params.fileName, {
    name: params.name,
    aliases: params.aliases?.join(','),
  });
}
