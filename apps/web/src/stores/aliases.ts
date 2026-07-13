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

type AliasMap = Record<string, string>;

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

interface AliasState {
  aliases: AliasMap;
  /** 给用户起备注（传空字符串即清除） */
  setUserAlias: (username: string, alias: string) => void;
  /** 给会话起备注（多人直聊、频道都可以） */
  setRoomAlias: (rid: string, alias: string) => void;
  userAlias: (username?: string) => string | undefined;
  roomAlias: (rid: string) => string | undefined;
}

export const useAliases = create<AliasState>((set, get) => ({
  aliases: load(),

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
): string {
  const roomAlias = aliases[`r:${conv.rid}`];
  if (roomAlias) return roomAlias;
  if (conv.avatarUsername) {
    const byUser = aliases[`u:${conv.avatarUsername}`];
    if (byUser) return byUser;
  }
  return conv.name;
}
