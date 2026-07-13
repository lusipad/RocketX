import { useSyncExternalStore } from 'react';

/**
 * 中文人名/群名的拼音检索。
 *
 * 中文用户的习惯是打拼音找人：「张三」既要能被 `zhangsan` 找到，也要能被首字母
 * `zs` 找到。Rocket.Chat 服务端只做原文匹配，所以拼音这一层必须在客户端补。
 *
 * pinyin-pro 带着一份完整字典，直接 import 会给首屏加约 300KB。所以这里异步加载：
 * 加载完成前退化成原文子串匹配，加载完再通知订阅方重算一次筛选结果。
 * 实际上启动时就开始预加载，用户点开搜索框时早就好了。
 */
type PinyinFn = (
  text: string,
  opts: { toneType: 'none'; type: 'array'; pattern?: 'first' },
) => string[];

let pinyinFn: PinyinFn | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function load(): Promise<void> {
  if (loading) return loading;
  loading = import('pinyin-pro')
    .then((m) => {
      pinyinFn = m.pinyin as unknown as PinyinFn;
      for (const l of listeners) l();
    })
    .catch(() => {
      // 加载失败就一直用原文匹配，不影响基本可用性
    });
  return loading;
}

/** 应用启动时预热，避免用户第一次搜索时才等字典 */
export function preloadPinyin(): void {
  void load();
}

/** 订阅「拼音字典已就绪」，就绪后让筛选结果重算一次 */
export function usePinyinReady(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => pinyinFn !== null,
    () => false,
  );
}

const cache = new Map<string, { full: string; initials: string }>();
const HAS_CJK = /[一-龥]/;

function toPinyin(text: string): { full: string; initials: string } | null {
  if (!pinyinFn) {
    void load();
    return null;
  }
  const hit = cache.get(text);
  if (hit) return hit;

  const lower = text.toLowerCase();
  // 纯英文名不需要转换，原样参与匹配即可
  const entry = HAS_CJK.test(text)
    ? {
        full: pinyinFn(text, { toneType: 'none', type: 'array' }).join('').toLowerCase(),
        initials: pinyinFn(text, { pattern: 'first', toneType: 'none', type: 'array' })
          .join('')
          .toLowerCase(),
      }
    : { full: lower, initials: lower };

  // 通讯录可能上千人，缓存做个上限，超了就整体丢弃重建（简单且够用）
  if (cache.size > 5000) cache.clear();
  cache.set(text, entry);
  return entry;
}

/**
 * 关键词是否命中候选项：原文包含、全拼包含、或首字母包含。
 * 传入多个字段（如姓名 + 用户名），任一命中即可。
 */
export function pinyinMatch(keyword: string, ...fields: (string | undefined)[]): boolean {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return true;

  for (const field of fields) {
    if (!field) continue;
    if (field.toLowerCase().includes(kw)) return true;
    const py = toPinyin(field);
    if (py && (py.full.includes(kw) || py.initials.includes(kw))) return true;
  }
  return false;
}

/**
 * 排序权重：越小越靠前。
 * 原文前缀 > 原文包含 > 拼音首字母前缀 > 全拼前缀 > 其他命中。
 */
export function pinyinScore(keyword: string, name: string): number {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return 0;
  const lower = name.toLowerCase();
  if (lower.startsWith(kw)) return 0;
  if (lower.includes(kw)) return 1;
  const py = toPinyin(name);
  if (!py) return 4;
  if (py.initials.startsWith(kw)) return 2;
  if (py.full.startsWith(kw)) return 3;
  return 4;
}
