import { create } from 'zustand';
import { getServerBase, loadStoredAuth, rest, savePreferences } from '../lib/client';
import { listArchivedEntries, removeArchivedEntry } from '../lib/accountScope';

/**
 * 备注名。
 *
 * Rocket.Chat 没有「给别人起备注」这个数据模型（它只有 name / username），
 * 所以借 users.setPreferences 的自定义键（rcxAliases / rcxNameFormat）存到服务端，
 * 重装/换设备后登录即可找回；localStorage 只作为本机缓存，保证离线可用、启动即见。
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
  /** 名字显示格式（与服务端 rcxNameFormat 同步，本地缓存保证离线可用） */
  nameFormat: NameFormat;
  /**
   * 登录后从服务端拉取备注合并进 store（服务端优先）。
   * 服务端为空而本机有数据时（首次登录/老版本升级）改为把本机数据迁移上传，
   * 避免服务端的空值把本地盖掉。
   */
  sync: () => Promise<void>;
  /** 给用户起备注（传空字符串即清除） */
  setUserAlias: (username: string, alias: string) => void;
  /** 给会话起备注（多人直聊、频道都可以） */
  setRoomAlias: (rid: string, alias: string) => void;
  setNameFormat: (f: NameFormat) => void;
  userAlias: (username?: string) => string | undefined;
  roomAlias: (rid: string) => string | undefined;
  /**
   * 导入一条旧服务器地址留下的归档备注：合并进当前备注（当前已有的键优先，
   * 归档只补缺不覆盖），写回服务端后删除归档，返回实际补入的条数。
   */
  importArchived: (owner: string) => Promise<number>;
}

/** 一条可导入的历史归档（换服务器地址后被账号隔离机制归档的备注） */
export interface ArchivedAliases {
  /** 归档 owner 串：`<userId>@<serverBase>` */
  owner: string;
  serverBase: string;
  count: number;
}

function currentOwner(): string | null {
  const auth = loadStoredAuth();
  if (!auth) return null;
  return `${auth.userId}@${getServerBase() || 'same-origin'}`;
}

function parseAliasMap(raw: string): AliasMap | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as AliasMap;
  } catch {
    return null;
  }
}

/**
 * 扫描 localStorage 里的 rcx-aliases 归档。当前账号的归档登录时已还原成裸 key，
 * 理论上不存在，仍容错排除；JSON 损坏的跳过并告警。
 */
export function listArchivedAliases(): ArchivedAliases[] {
  const current = currentOwner();
  const out: ArchivedAliases[] = [];
  for (const { owner, raw } of listArchivedEntries(KEY)) {
    if (owner === current) continue;
    const map = parseAliasMap(raw);
    if (!map) {
      console.warn(`[aliases] 归档 ${owner} 数据损坏，已跳过`);
      continue;
    }
    const count = Object.keys(map).length;
    if (count === 0) continue;
    out.push({ owner, serverBase: owner.slice(owner.indexOf('@') + 1), count });
  }
  return out;
}

/**
 * 写回失败不回滚本地：备注先在本机生效，下次登录再以服务端为准收敛。
 * 但失败不能无声无息——live 验证曾发现 RC 8.6 REST 校验拒绝自定义键、
 * 界面毫无感知的问题；至少留下诊断日志。
 */
function pushToServer(data: { rcxAliases?: AliasMap; rcxNameFormat?: NameFormat }): Promise<boolean> {
  return savePreferences(data).then(
    () => true,
    (err) => {
      console.warn('[aliases] 备注名写回服务端失败，已保留本机缓存，下次登录再同步：', err);
      return false;
    },
  );
}

/** 正在飞的那次同步。并发调用共用它，不会重复拉 users.info */
let inflight: Promise<void> | null = null;

function persistFormat(f: NameFormat): void {
  try {
    localStorage.setItem(FORMAT_KEY, f);
  } catch {
    /* 存储满/无痕 */
  }
}

export const useAliases = create<AliasState>((set, get) => ({
  aliases: load(),
  nameFormat: loadFormat(),

  sync: () => {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const explicit = await rest.getExplicitPreferences();
        const serverAliases = explicit.rcxAliases;
        const local = get().aliases;
        if (serverAliases && Object.keys(serverAliases).length > 0) {
          // 服务端优先合并：重装/换设备后把服务端备注拉回本地缓存；
          // 本地多出来的键保留（可能还没来得及上传）
          const merged = { ...local, ...serverAliases };
          set({ aliases: merged });
          persist(merged);
        } else if (Object.keys(local).length > 0) {
          // 服务端还没有备注：把本机数据迁移上传。
          // 服务端已有格式偏好时（别的设备清空过备注）不要顺手盖掉它
          await savePreferences({
            rcxAliases: local,
            ...(explicit.rcxNameFormat ? {} : { rcxNameFormat: get().nameFormat }),
          });
        }
        if (explicit.rcxNameFormat && explicit.rcxNameFormat !== get().nameFormat) {
          persistFormat(explicit.rcxNameFormat);
          set({ nameFormat: explicit.rcxNameFormat });
        }
      } catch {
        // 同步失败不阻塞使用：localStorage 缓存仍在，下次登录再同步
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  },

  setNameFormat: (f) => {
    persistFormat(f);
    set({ nameFormat: f });
    pushToServer({ rcxNameFormat: f });
  },

  setUserAlias: (username, alias) => {
    const next = { ...get().aliases };
    const key = `u:${username}`;
    if (alias.trim()) next[key] = alias.trim();
    else delete next[key];
    set({ aliases: next });
    persist(next);
    pushToServer({ rcxAliases: next });
  },

  setRoomAlias: (rid, alias) => {
    const next = { ...get().aliases };
    const key = `r:${rid}`;
    if (alias.trim()) next[key] = alias.trim();
    else delete next[key];
    set({ aliases: next });
    persist(next);
    pushToServer({ rcxAliases: next });
  },

  userAlias: (username) => (username ? get().aliases[`u:${username}`] : undefined),
  roomAlias: (rid) => get().aliases[`r:${rid}`],

  importArchived: async (owner) => {
    const entry = listArchivedEntries(KEY).find((e) => e.owner === owner);
    if (!entry) return 0;
    const archived = parseAliasMap(entry.raw);
    if (!archived) {
      console.warn(`[aliases] 归档 ${owner} 数据损坏，无法导入`);
      return 0;
    }
    const current = get().aliases;
    // 当前已有的键优先：归档只补缺，不覆盖
    const merged = { ...archived, ...current };
    const added = Object.keys(archived).filter((k) => !(k in current)).length;
    set({ aliases: merged });
    persist(merged);
    // 只有服务端确认写入成功后才删除归档；否则保留归档，避免离线导入时丢失可恢复数据。
    if (await pushToServer({ rcxAliases: merged })) removeArchivedEntry(KEY, owner);
    return added;
  },
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
