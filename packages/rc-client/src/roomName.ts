/**
 * Rocket.Chat 房间名（slug）约束。
 *
 * issue #392：服务端对房间名有 slug 校验（默认 `UTF8_Channel_Names_Validation`
 * 等价于 `/^[0-9a-zA-Z-_.]+$/`），不满足时 REST 直接返回
 * `X is not a valid room name. [error-invalid-room-name]`。而创建讨论组的几条
 * 路径此前把「消息原文」或「#123 工作项标题」直接当讨论名发出去：消息原文里
 * 的空格、标点、中文一律违规，于是「在群里创建讨论组」必然失败。
 *
 * 这里把清洗集中到 rc-client 边界，让所有调用方（右键创建讨论、工作项讨论、
 * 工作项创建后建讨论）共用同一套规则，而不是各自 `trim()` 一下。
 */

/**
 * 服务端默认房间名长度上限（`Room_Name_Max_Length` 默认 50）。
 * 超出由服务端截断，而我们这边截断才能保证「界面显示的名字 = 实际落库的名字」。
 */
export const ROOM_NAME_MAX_LENGTH = 50;

/**
 * 允许的字符集：服务端 slug 校验默认只放行 ASCII 字母数字与 `-_.`。
 * 注意这里只放行 ASCII —— 中文、全角标点、emoji 都必须换成 `-`，
 * 只有合法 slug 才进得了服务端。
 */
const INVALID_RUN_RE = /[^0-9a-zA-Z-_.]+/g;

/** 单个 slug 片段最长多少字符内不附加摘要，避免短名字被无谓地加后缀。 */
const MAX_COLLAPSED_KEEP = 40;

/** 摘要长度（十六进制字符），用于给被清空或被截断的名字保留区分度。 */
const DIGEST_LENGTH = 8;

/**
 * 名字被清洗后仍要保证区分度：多个不同的中文标题清成同一个 `-` 就会互相撞名，
 * 表现为「第二次创建讨论提示房间已存在」。这里用原始名字算一个稳定摘要。
 */
function nameDigest(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(DIGEST_LENGTH, '0').slice(0, DIGEST_LENGTH);
}

/**
 * 把任意用户输入/消息原文转成服务端一定接受的房间名。
 *
 * 规则：
 * - 非法字符（空格、标点、中文、emoji…）折叠成单个 `-`；
 * - 去掉首尾分隔符，避免出现 `-foo` / `foo-` 这类看着像残缺的名字；
 * - 长度上限 `ROOM_NAME_MAX_LENGTH`；
 * - 清洗后为空（例如纯中文名）时用 `fallback` + 原始名字摘要兜底，
 *   既不违反字符集，也不会让同一父群下的多条讨论撞名。
 */
export function slugifyRoomName(input: string, fallback = 'room'): string {
  const raw = (input ?? '').trim();
  const safeFallback = (fallback ?? '').replace(INVALID_RUN_RE, '-').replace(/^[-_.]+|[-_.]+$/g, '') || 'room';
  if (!raw) return safeFallback.slice(0, ROOM_NAME_MAX_LENGTH);

  let slug = raw.replace(INVALID_RUN_RE, '-').replace(/^[-_.]+|[-_.]+$/g, '');

  if (!slug) {
    // 全非法字符：只能靠摘要保留区分度。
    return `${safeFallback}-${nameDigest(raw)}`.slice(0, ROOM_NAME_MAX_LENGTH);
  }

  if (slug.length > ROOM_NAME_MAX_LENGTH) {
    const digest = nameDigest(raw);
    const keep = Math.max(1, Math.min(MAX_COLLAPSED_KEEP, ROOM_NAME_MAX_LENGTH - digest.length - 1));
    slug = `${slug.slice(0, keep).replace(/[-_.]+$/, '')}-${digest}`;
  }

  return slug.slice(0, ROOM_NAME_MAX_LENGTH).replace(/[-_.]+$/, '') || safeFallback.slice(0, ROOM_NAME_MAX_LENGTH);
}
