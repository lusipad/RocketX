import type { StickerEntry } from './stickerManifest';

const SAFE_STICKER_ID_RE = /^[a-z0-9_-]+$/;
const STATIC_STICKER_PREFIX = 'rocketx_sticker_twemoji_';
const ANIMATED_STICKER_PREFIX = 'rocketx_sticker_noto_animated_';
const SHORTCODE_RE = /^:(rocketx_sticker_(twemoji|noto_animated)_[a-z0-9_-]+):$/;

export type StickerServerEmojiCreateResult = 'created' | 'forbidden' | 'collision';
export type StickerServerEmojiState = 'owned' | 'foreign' | 'missing';

export function builtinStickerServerEmojiName(
  sticker: Pick<StickerEntry, 'packageId' | 'id' | 'mimeType'>,
): string | null {
  const id = sticker.id.trim();
  if (!SAFE_STICKER_ID_RE.test(id)) return null;
  if (sticker.packageId === 'twemoji' && sticker.mimeType === 'image/png') {
    return `${STATIC_STICKER_PREFIX}${id}`;
  }
  if (sticker.packageId === 'noto-animated' && sticker.mimeType === 'image/gif') {
    return `${ANIMATED_STICKER_PREFIX}${id}_gif`;
  }
  return null;
}

export function builtinStickerServerEmojiAlias(name: string): string {
  return `${name}_asset`;
}

export function parseRocketXStickerShortcodeMessage(
  message: string,
): { name: string; format: 'png' | 'gif' } | null {
  const match = SHORTCODE_RE.exec(message.trim());
  if (!match) return null;
  const animated = match[2] === 'noto_animated';
  if (animated !== match[1].endsWith('_gif')) return null;
  return { name: match[1], format: animated ? 'gif' : 'png' };
}

export function classifyServerEmojiCreateError(
  error: unknown,
): 'forbidden' | 'collision' | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { status?: unknown; errorType?: unknown; message?: unknown };
  if (typeof candidate.status !== 'number') return null;
  if (candidate.status === 401) return null;
  const detail = `${typeof candidate.errorType === 'string' ? candidate.errorType : ''} ${
    typeof candidate.message === 'string' ? candidate.message : ''
  }`;
  if (
    candidate.status === 409
    || /duplicate|already[ _-](?:exists|in[ _-]use)|same[ _-]name|name.*alias.*(?:exists|in[ _-]use)/i.test(detail)
  ) return 'collision';
  if (
    candidate.status === 403
    || /forbidden|not[ _-]authorized|not[ _-]allowed|manage[ _-]emoji|permission/i.test(detail)
  ) return 'forbidden';
  return null;
}

export async function sendBuiltinStickerWithServerCompat(
  sticker: StickerEntry,
  deps: {
    inspectServerEmoji(name: string): Promise<StickerServerEmojiState>;
    createServerEmoji(
      sticker: StickerEntry,
      name: string,
    ): Promise<StickerServerEmojiCreateResult>;
    sendShortcodeMessage(shortcode: string): Promise<void>;
    sendImageAttachmentFallback(sticker: StickerEntry): Promise<void>;
  },
): Promise<void> {
  const name = builtinStickerServerEmojiName(sticker);
  if (!name) {
    await deps.sendImageAttachmentFallback(sticker);
    return;
  }
  const state = await deps.inspectServerEmoji(name);
  if (state === 'owned') {
    await deps.sendShortcodeMessage(`:${name}:`);
    return;
  }
  if (state === 'foreign') {
    await deps.sendImageAttachmentFallback(sticker);
    return;
  }
  const created = await deps.createServerEmoji(sticker, name);
  if (created === 'created') {
    await deps.sendShortcodeMessage(`:${name}:`);
    return;
  }
  if (created === 'collision') {
    const stateAfterCollision = await deps.inspectServerEmoji(name);
    if (stateAfterCollision === 'owned') {
      await deps.sendShortcodeMessage(`:${name}:`);
      return;
    }
    await deps.sendImageAttachmentFallback(sticker);
    return;
  }
  if (created === 'forbidden') {
    await deps.sendImageAttachmentFallback(sticker);
    return;
  }
  const unreachable: never = created;
  throw new Error(`未知贴纸兼容结果: ${unreachable}`);
}

export async function pickComposerStickerWithServerCompat(
  sticker: StickerEntry,
  caption: string,
  deps: {
    sendBuiltinStickerWithServerCompat(sticker: StickerEntry): Promise<void>;
    requestUpload(files: File[], caption: string): void;
    fetchStickerFile(sticker: StickerEntry): Promise<File>;
  },
): Promise<void> {
  if (!caption.trim() && builtinStickerServerEmojiName(sticker)) {
    await deps.sendBuiltinStickerWithServerCompat(sticker);
    return;
  }
  const file = await deps.fetchStickerFile(sticker);
  deps.requestUpload([file], caption);
}
