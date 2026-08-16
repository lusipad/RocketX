import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { RcApiError } from '../../packages/rc-client/src/rest';
import type { StickerEntry } from '../../apps/web/src/lib/stickerManifest';

type StickerServerCompatModule = {
  builtinStickerServerEmojiName: (
    sticker: Pick<StickerEntry, 'packageId' | 'id' | 'mimeType'>,
  ) => string | null;
  parseRocketXStickerShortcodeMessage: (
    message: string,
  ) => { name: string; format: 'png' | 'gif' } | null;
  classifyServerEmojiCreateError: (
    error: unknown,
  ) => 'forbidden' | 'collision' | null;
  pickComposerStickerWithServerCompat: (
    sticker: StickerEntry,
    caption: string,
    deps: {
      sendBuiltinStickerWithServerCompat(sticker: StickerEntry): Promise<void>;
      requestUpload(files: File[], caption: string): void;
      fetchStickerFile(sticker: StickerEntry): Promise<File>;
    },
  ) => Promise<void>;
  sendBuiltinStickerWithServerCompat: (
    sticker: StickerEntry,
    deps: {
      inspectServerEmoji(name: string): Promise<'owned' | 'foreign' | 'missing'>;
      createServerEmoji(sticker: StickerEntry, name: string): Promise<'created' | 'forbidden'>;
      sendShortcodeMessage(shortcode: string): Promise<void>;
      sendImageAttachmentFallback(sticker: StickerEntry): Promise<void>;
    },
  ) => Promise<void>;
};

async function loadSubject(): Promise<StickerServerCompatModule> {
  return await import('../../apps/web/src/lib/stickerServerCompat') as StickerServerCompatModule;
}

function makeSticker(overrides: Partial<StickerEntry> = {}): StickerEntry {
  return {
    id: '1f914',
    title: '思考',
    packageId: 'twemoji',
    packageTitle: 'Twemoji',
    groupId: 'discussion-mood',
    groupTitle: '讨论中',
    src: '/stickers/twemoji/thinking.png',
    fileName: 'thinking.png',
    mimeType: 'image/png',
    tags: ['thinking'],
    ...overrides,
  };
}

function readSource(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('只有内置 twemoji 贴纸映射到稳定服务器名称', async () => {
  const { builtinStickerServerEmojiName } = await loadSubject();

  assert.equal(
    builtinStickerServerEmojiName(makeSticker({ packageId: 'twemoji', id: '1f914' })),
    'rocketx_sticker_twemoji_1f914',
  );
  assert.equal(
    builtinStickerServerEmojiName(makeSticker({ packageId: 'favorites', id: '1f914' })),
    null,
  );
  assert.equal(
    builtinStickerServerEmojiName(makeSticker({ packageId: 'twemoji', id: 'thinking' })),
    'rocketx_sticker_twemoji_thinking',
  );
});

test('内置 Noto GIF 贴纸映射到稳定服务器名称并带 gif 后缀', async () => {
  const { builtinStickerServerEmojiName } = await loadSubject();

  assert.equal(
    builtinStickerServerEmojiName(makeSticker({
      packageId: 'noto-animated',
      id: 'celebrate_animated',
      mimeType: 'image/gif',
      fileName: 'celebrate.gif',
      src: '/stickers/noto-animated/celebrate.gif',
    })),
    'rocketx_sticker_noto_animated_celebrate_animated_gif',
  );
});

test('shortcode 识别只接受单一 rocketx_sticker 消息', async () => {
  const { parseRocketXStickerShortcodeMessage } = await loadSubject();

  assert.deepEqual(
    parseRocketXStickerShortcodeMessage(':rocketx_sticker_twemoji_1f914:'),
    { name: 'rocketx_sticker_twemoji_1f914', format: 'png' },
  );
  assert.deepEqual(
    parseRocketXStickerShortcodeMessage(':rocketx_sticker_noto_animated_celebrate_animated_gif:'),
    { name: 'rocketx_sticker_noto_animated_celebrate_animated_gif', format: 'gif' },
  );
  assert.equal(parseRocketXStickerShortcodeMessage(':smile:'), null);
  assert.equal(parseRocketXStickerShortcodeMessage(':rocketx_sticker_twemoji_1f914: 你好'), null);
  assert.equal(parseRocketXStickerShortcodeMessage('你好 :rocketx_sticker_twemoji_1f914:'), null);
  assert.equal(parseRocketXStickerShortcodeMessage(':rocketx_sticker_../../admin:'), null);
  assert.equal(
    parseRocketXStickerShortcodeMessage(':rocketx_sticker_twemoji_1f914::rocketx_sticker_twemoji_1f44d:'),
    null,
  );
});

test('已安装时直接发送 shortcode', async () => {
  const { sendBuiltinStickerWithServerCompat } = await loadSubject();
  const calls: string[] = [];
  const sticker = makeSticker();

  await sendBuiltinStickerWithServerCompat(sticker, {
    async inspectServerEmoji(name) {
      calls.push(`inspect:${name}`);
      return 'owned';
    },
    async createServerEmoji(_candidate, name) {
      calls.push(`create:${name}`);
      return 'created';
    },
    async sendShortcodeMessage(shortcode) {
      calls.push(`send:${shortcode}`);
    },
    async sendImageAttachmentFallback(_candidate) {
      calls.push('fallback');
    },
  });

  assert.deepEqual(calls, [
    'inspect:rocketx_sticker_twemoji_1f914',
    'send::rocketx_sticker_twemoji_1f914:',
  ]);
});

test('未安装且可创建时先创建再发送 shortcode', async () => {
  const { sendBuiltinStickerWithServerCompat } = await loadSubject();
  const calls: string[] = [];
  const sticker = makeSticker();

  await sendBuiltinStickerWithServerCompat(sticker, {
    async inspectServerEmoji(name) {
      calls.push(`inspect:${name}`);
      return 'missing';
    },
    async createServerEmoji(_candidate, name) {
      calls.push(`create:${name}`);
      return 'created';
    },
    async sendShortcodeMessage(shortcode) {
      calls.push(`send:${shortcode}`);
    },
    async sendImageAttachmentFallback(_candidate) {
      calls.push('fallback');
    },
  });

  assert.deepEqual(calls, [
    'inspect:rocketx_sticker_twemoji_1f914',
    'create:rocketx_sticker_twemoji_1f914',
    'send::rocketx_sticker_twemoji_1f914:',
  ]);
});

test('并发创建冲突后重新确认 owned 资源并发送 shortcode', async () => {
  const { sendBuiltinStickerWithServerCompat } = await loadSubject();
  const calls: string[] = [];
  const sticker = makeSticker();
  let inspection = 0;

  await sendBuiltinStickerWithServerCompat(sticker, {
    async inspectServerEmoji(name) {
      inspection += 1;
      calls.push(`inspect-${inspection}:${name}`);
      return inspection === 1 ? 'missing' : 'owned';
    },
    async createServerEmoji(_candidate, name) {
      calls.push(`create:${name}`);
      return 'collision';
    },
    async sendShortcodeMessage(shortcode) {
      calls.push(`send:${shortcode}`);
    },
    async sendImageAttachmentFallback(_candidate) {
      calls.push('fallback');
    },
  });

  assert.deepEqual(calls, [
    'inspect-1:rocketx_sticker_twemoji_1f914',
    'create:rocketx_sticker_twemoji_1f914',
    'inspect-2:rocketx_sticker_twemoji_1f914',
    'send::rocketx_sticker_twemoji_1f914:',
  ]);
});

test('并发创建冲突后二次确认 foreign 才回退附件', async () => {
  const { sendBuiltinStickerWithServerCompat } = await loadSubject();
  const calls: string[] = [];
  const sticker = makeSticker();
  let inspection = 0;

  await sendBuiltinStickerWithServerCompat(sticker, {
    async inspectServerEmoji(name) {
      inspection += 1;
      calls.push(`inspect-${inspection}:${name}`);
      return inspection === 1 ? 'missing' : 'foreign';
    },
    async createServerEmoji(_candidate, name) {
      calls.push(`create:${name}`);
      return 'collision';
    },
    async sendShortcodeMessage(shortcode) {
      calls.push(`send:${shortcode}`);
    },
    async sendImageAttachmentFallback(_candidate) {
      calls.push('fallback');
    },
  });

  assert.deepEqual(calls, [
    'inspect-1:rocketx_sticker_twemoji_1f914',
    'create:rocketx_sticker_twemoji_1f914',
    'inspect-2:rocketx_sticker_twemoji_1f914',
    'fallback',
  ]);
});

test('401 登录失效不会被误判为无贴纸管理权限', async () => {
  const { classifyServerEmojiCreateError } = await loadSubject();

  assert.equal(
    classifyServerEmojiCreateError(new RcApiError('登录已失效', 401, 'error-unauthorized')),
    null,
  );
  assert.equal(
    classifyServerEmojiCreateError(new RcApiError('没有 manage-emoji 权限', 403, 'error-not-allowed')),
    'forbidden',
  );
  assert.equal(
    classifyServerEmojiCreateError(
      new RcApiError(
        'Name or alias already in use',
        400,
        'Custom_Emoji_Error_Name_Or_Alias_Already_In_Use',
      ),
    ),
    'collision',
  );
});

test('创建权限失败时回退图片附件发送', async () => {
  const { sendBuiltinStickerWithServerCompat } = await loadSubject();
  const calls: string[] = [];
  const sticker = makeSticker();

  await sendBuiltinStickerWithServerCompat(sticker, {
    async inspectServerEmoji(name) {
      calls.push(`inspect:${name}`);
      return 'missing';
    },
    async createServerEmoji(_candidate, name) {
      calls.push(`create:${name}`);
      return 'forbidden';
    },
    async sendShortcodeMessage(shortcode) {
      calls.push(`send:${shortcode}`);
    },
    async sendImageAttachmentFallback(_candidate) {
      calls.push('fallback');
    },
  });

  assert.deepEqual(calls, [
    'inspect:rocketx_sticker_twemoji_1f914',
    'create:rocketx_sticker_twemoji_1f914',
    'fallback',
  ]);
});

test('同名 emoji 缺少 ownership marker 时不能当作已安装贴纸', async () => {
  const { sendBuiltinStickerWithServerCompat } = await loadSubject();
  const calls: string[] = [];
  const sticker = makeSticker();

  await sendBuiltinStickerWithServerCompat(sticker, {
    async inspectServerEmoji(name) {
      calls.push(`inspect:${name}`);
      return 'foreign';
    },
    async createServerEmoji(_candidate, name) {
      calls.push(`create:${name}`);
      return 'created';
    },
    async sendShortcodeMessage(shortcode) {
      calls.push(`send:${shortcode}`);
    },
    async sendImageAttachmentFallback(_candidate) {
      calls.push('fallback');
    },
  });

  assert.deepEqual(calls, [
    'inspect:rocketx_sticker_twemoji_1f914',
    'fallback',
  ]);
});

test('生产查询不能跨调用复用已安装结果缓存', async () => {
  const { sendBuiltinStickerWithServerCompat } = await loadSubject();
  const sticker = makeSticker();
  const calls: string[] = [];

  await sendBuiltinStickerWithServerCompat(sticker, {
    async inspectServerEmoji(name) {
      calls.push(`first-inspect:${name}`);
      return 'owned';
    },
    async createServerEmoji(_candidate, name) {
      calls.push(`first-create:${name}`);
      return 'created';
    },
    async sendShortcodeMessage(shortcode) {
      calls.push(`first-send:${shortcode}`);
    },
    async sendImageAttachmentFallback(_candidate) {
      calls.push('first-fallback');
    },
  });

  await sendBuiltinStickerWithServerCompat(sticker, {
    async inspectServerEmoji(name) {
      calls.push(`second-inspect:${name}`);
      return 'missing';
    },
    async createServerEmoji(_candidate, name) {
      calls.push(`second-create:${name}`);
      return 'forbidden';
    },
    async sendShortcodeMessage(shortcode) {
      calls.push(`second-send:${shortcode}`);
    },
    async sendImageAttachmentFallback(_candidate) {
      calls.push('second-fallback');
    },
  });

  assert.deepEqual(calls, [
    'first-inspect:rocketx_sticker_twemoji_1f914',
    'first-send::rocketx_sticker_twemoji_1f914:',
    'second-inspect:rocketx_sticker_twemoji_1f914',
    'second-create:rocketx_sticker_twemoji_1f914',
    'second-fallback',
  ]);
});

test('Composer 仅在无 caption 时才允许走服务器 shortcode 路径', async () => {
  const { pickComposerStickerWithServerCompat } = await loadSubject();
  const sticker = makeSticker();
  const sent: string[] = [];

  await pickComposerStickerWithServerCompat(sticker, '', {
    async sendBuiltinStickerWithServerCompat(_candidate) {
      sent.push('server');
    },
    requestUpload(_files, caption) {
      sent.push(`upload:${caption}`);
    },
    async fetchStickerFile(_candidate) {
      return new File([new Uint8Array([1])], 'thinking.png', { type: 'image/png' });
    },
  });

  await pickComposerStickerWithServerCompat(sticker, '附一句话', {
    async sendBuiltinStickerWithServerCompat(_candidate) {
      sent.push('server-with-caption');
    },
    requestUpload(files, caption) {
      sent.push(`upload:${files.length}:${caption}`);
    },
    async fetchStickerFile(_candidate) {
      return new File([new Uint8Array([1])], 'thinking.png', { type: 'image/png' });
    },
  });

  assert.deepEqual(sent, [
    'server',
    'upload:1:附一句话',
  ]);
});

test('Composer 静态门禁：贴纸选择必须保留 caption 附件路径，而不是无条件上传', () => {
  const source = readSource('../../apps/web/src/components/Composer.tsx');

  assert.doesNotMatch(
    source,
    /requestUpload\(\[file\],\s*text\);\s*setStickerPicker\(false\);/m,
  );
  assert.match(source, /sendBuiltinStickerWithServerCompat|pickComposerStickerWithServerCompat/);
});

test('MessageItem 静态门禁：整条 sticker shortcode 必须在 renderMarkdown 前特判并走 AuthImage', () => {
  const source = readSource('../../apps/web/src/components/MessageItem.tsx');
  const renderMarkdownIndex = source.indexOf('renderMarkdown(visibleText');
  const parseIndex = source.indexOf('parseRocketXStickerShortcodeMessage');

  assert.notEqual(parseIndex, -1, '缺少 sticker shortcode 解析入口');
  assert.notEqual(renderMarkdownIndex, -1, '缺少 markdown 文本渲染入口');
  assert.ok(parseIndex < renderMarkdownIndex, 'sticker shortcode 必须先于 markdown 文本分支判定');
  assert.match(source, /AuthImage/);
  assert.doesNotMatch(
    source,
    /emoji-custom\/\$\{[^}]+\}\.png/,
    'MessageItem 不能把所有服务器贴纸硬编码成 .png',
  );
  assert.match(
    source,
    /emoji-custom\/\$\{[^}]+\}\.\$\{[^}]+\}/,
    'MessageItem 应按 shortcode 解析出的格式拼接资源后缀',
  );
});
