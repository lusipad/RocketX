/**
 * 本地数据的账号隔离。
 *
 * 所有 rcx-* 本地数据的 key 都不带账号前缀,而各 store 又在模块顶层就从
 * localStorage 加载 —— 那个时机根本不知道 userId,给每个 store 改带前缀的 key
 * 侵入面太大。这里改用「换账号时整体搬移」:
 *
 * 登录成功后对比 rcx-owner(这批数据属于谁)。换了人,就把裸 key 归档成
 * `<key>#<旧owner>`、再把新账号的归档(如果有)搬回裸 key,然后由调用方 reload
 * 让所有 store 重新加载。效果:
 *   - B 登录看不到 A 的待办/草稿/日历/备注名/ADO 配置(此前是内容泄露);
 *   - B 的 GroupFilter prune 洗的是 B 自己的分组,不再把 A 的分组内容永久擦空;
 *   - A 再登录时归档原样搬回,数据不丢。
 */
import { getServerBase } from './client';

const OWNER_KEY = 'rcx-owner';

/** 跟账号走的本地数据。设备级的(rcx-auth/server/site-url/theme)不在内 */
const SCOPED_KEYS = [
  'rcx-folders',
  'rcx-collapsed',
  'rcx-todos',
  'rcx-aliases',
  'rcx-drafts',
  'rcx-calendar',
  'rcx-favorites',
  'rcx-recent-emojis',
  'rcx-avatar-version',
  // ADO 配置含账号(直连模式还可能有凭据缓存),同样不能跨账号共享
  'rcx-workbench',
  'rcx-ado-web',
  'rcx-custom-queries',
];

/**
 * 登录成功后调用。返回 'switched' 表示换了账号且已完成数据搬移,
 * 调用方应立即 location.reload() 让所有 store 从搬好的数据重新加载。
 */
export function ensureAccountScope(userId: string): 'ok' | 'switched' {
  try {
    const owner = `${userId}@${getServerBase() || 'same-origin'}`;
    const prev = localStorage.getItem(OWNER_KEY);
    if (prev === owner) return 'ok';
    if (prev) {
      // 归档上一个账号的数据
      for (const k of SCOPED_KEYS) {
        const v = localStorage.getItem(k);
        if (v !== null) localStorage.setItem(`${k}#${prev}`, v);
        localStorage.removeItem(k);
      }
      // 还原当前账号之前的归档(有才搬,没有就保持干净的空状态)
      for (const k of SCOPED_KEYS) {
        const archived = localStorage.getItem(`${k}#${owner}`);
        if (archived !== null) {
          localStorage.setItem(k, archived);
          localStorage.removeItem(`${k}#${owner}`);
        }
      }
    }
    localStorage.setItem(OWNER_KEY, owner);
    // 首次(prev 为空)只是认领现有数据,不需要 reload
    return prev ? 'switched' : 'ok';
  } catch {
    // 存储不可用时无从隔离,也不该拦住登录
    return 'ok';
  }
}
