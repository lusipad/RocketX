import { create } from 'zustand';

/**
 * 备注名。
 *
 * Rocket.Chat 没有「给别人起备注」这个数据模型（它只有 name / username），
 * 所以存在本机，跨设备不同步——和自定义分组同样的取舍。
 *
 * 两类 key：
 * - `u:<username>` 给人起的备注（在通讯录、@ 补全、单聊会话名里生效）
 * - `r:<rid>`      给会话起的备注（主要用于多人直聊——它默认叫「张三, 李四」，很难认）
 */
const KEY = 'rcx-aliases';
const FORMAT_KEY = 'rcx-name-format';

type AliasMap = Record<string, string>;
/** 名字显示格式：只显示备注名 / 备注名（原名） */
export type NameFormat = 'alias' | 'aliasWithReal';

function load(): AliasMap {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as AliasMap;
  } catch {
    return {};
  }
}

function persist(map: AliasMap): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* 存储满 */
  }
}

function loadFormat(): NameFormat {
  try {
    return localStorage.getItem(FORMAT_KEY) === 'aliasWithReal' ? 'aliasWithReal' : 'alias';
  } catch {
    return 'alias';
  }
}

interface AliasState {
  aliases: AliasMap;
  /** 名字显示格式（本地存，不走 RC prefs——备注本身就是本机数据） */
  nameFormat: NameFormat;
  /** 给用户起备注（传空字符串即清除） */
  setUserAlias: (username: string, alias: string) => void;
  /** 给会话起备注（多人直聊、频道都可以） */
  setRoomAlias: (rid: string, alias: string) => void;
  setNameFormat: (f: NameFormat) => void;
  userAlias: (username?: string) => string | undefined;
  roomAlias: (rid: string) => string | undefined;
}

export const useAliases = create<AliasState>((set, get) => ({
  aliases: load(),
  nameFormat: loadFormat(),

  setNameFormat: (f) => {
    try {
      localStorage.setItem(FORMAT_KEY, f);
    } catch {
      /* 存储满/无痕 */
    }
    set({ nameFormat: f });
  },

  setUserAlias: (username, alias) => {
    const next = { ...get().aliases };
    const key = `u:${username}`;
    if (alias.trim()) next[key] = alias.trim();
    else delete next[key];
    set({ aliases: next });
    persist(next);
  },

  setRoomAlias: (rid, alias) => {
    const next = { ...get().aliases };
    const key = `r:${rid}`;
    if (alias.trim()) next[key] = alias.trim();
    else delete next[key];
    set({ aliases: next });
    persist(next);
  },

  userAlias: (username) => (username ? get().aliases[`u:${username}`] : undefined),
  roomAlias: (rid) => get().aliases[`r:${rid}`],
}));

/**
 * 会话的显示名：会话备注 > 单聊对方的用户备注 > 原名。
 * 传 aliases 快照而不是在函数里调 store，这样在 useMemo 里依赖能被正确追踪。
 *
 * 单聊要按「对方用户名」查用户备注：会话显示名是 fname（张三），
 * 用户名在 avatarUsername 上（zhangsan）——给人起的备注得跟着人走，
 * 在通讯录改了，单聊会话名也要跟着变。
 */
export function displayName(
  aliases: AliasMap,
  conv: { rid: string; name: string; avatarUsername?: string },
  format: NameFormat = 'alias',
): string {
  const alias =
    aliases[`r:${conv.rid}`] ??
    (conv.avatarUsername ? aliases[`u:${conv.avatarUsername}`] : undefined);
  if (!alias) return conv.name;
  return format === 'aliasWithReal' && alias !== conv.name ? `${alias}（${conv.name}）` : alias;
}

/** 给「人」的显示名：备注名，或按格式带上原名。用于成员/联系人/个人卡片 */
export function personName(
  aliases: AliasMap,
  username: string,
  realName: string,
  format: NameFormat = 'alias',
): string {
  const alias = aliases[`u:${username}`];
  if (!alias) return realName;
  return format === 'aliasWithReal' && alias !== realName ? `${alias}（${realName}）` : alias;
}
