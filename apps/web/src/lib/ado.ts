/** 工作台（Azure DevOps）客户端侧：配置读写 + 经 ado-bridge 的查询 */

export const WORKBENCH_CONFIG_KEY = 'rcx-workbench';
/** markdown 渲染器用它把消息里的 #123 链接到 ADO 工作项 */
export const ADO_WEB_KEY = 'rcx-ado-web';

export interface WorkbenchConfig {
  /** direct = 客户端直连 ADO（桌面端推荐）；bridge = 经 ado-bridge 服务 */
  mode: 'bridge' | 'direct';
  bridge?: string;
  adoBase?: string;
  pat?: string;
  /** 直连的认证方式（自动探测得出）。ntlm = Windows 集成认证，桌面端默认 */
  auth?: import('./adoDirect').AdoAuth;
  account: string;
}

export function loadWorkbenchConfig(): WorkbenchConfig | null {
  try {
    const raw = localStorage.getItem(WORKBENCH_CONFIG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WorkbenchConfig;
    // 旧版配置没有 mode 字段，视为桥接模式
    if (!parsed.mode) parsed.mode = 'bridge';
    return parsed;
  } catch {
    return null;
  }
}

export function saveWorkbenchConfig(config: WorkbenchConfig): void {
  localStorage.setItem(WORKBENCH_CONFIG_KEY, JSON.stringify(config));
}

/** 消息里的 #123 要不要渲染成 ADO 工作项链接，取决于这个是否配过 */
export function adoWebBase(): string | null {
  // 渲染函数会走到这里，而它也在 Node 侧的测试里跑 —— 别假设有浏览器全局
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(ADO_WEB_KEY);
  } catch {
    return null;
  }
}

export interface AdoWorkItemInfo {
  id: number;
  title: string;
  type: string;
  state: string;
  priority?: number;
  project: string;
  assignedTo?: string;
  webUrl: string;
}

const itemCache = new Map<string, { item: AdoWorkItemInfo | null; ts: number }>();
const inflight = new Map<string, Promise<AdoWorkItemInfo | null>>();
const CACHE_TTL = 60_000;

function itemKey(config: WorkbenchConfig, id: number): string {
  const endpoint = config.mode === 'direct' ? config.adoBase : config.bridge;
  return `${config.mode}:${endpoint ?? ''}:${config.account}:${id}`;
}

/** 悬停卡片查询：60s 缓存 + 并发去重；未配置工作台返回 null */
export function fetchWorkItem(id: number): Promise<AdoWorkItemInfo | null> {
  const config = loadWorkbenchConfig();
  if (!config) return Promise.resolve(null);
  const key = itemKey(config, id);

  const cached = itemCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return Promise.resolve(cached.item);

  const existing = inflight.get(key);
  if (existing) return existing;

  const load =
    config.mode === 'direct' && config.adoBase
      ? import('./adoDirect').then((m) =>
          m.directGetWorkItem(
            { adoBase: config.adoBase!, pat: config.pat!, auth: config.auth },
            id,
          ),
        )
      : fetch(`${config.bridge}/api/ado/workitem/${id}`).then(async (res) =>
          res.ok ? ((await res.json()) as { item: AdoWorkItemInfo }).item : null,
        );

  const promise = load
    .then((item) => {
      itemCache.set(key, { item: item ?? null, ts: Date.now() });
      return item ?? null;
    })
    .catch(() => {
      itemCache.set(key, { item: null, ts: Date.now() });
      return null;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

export async function commentWorkItem(id: number, text: string): Promise<void> {
  const config = loadWorkbenchConfig();
  if (!config) throw new Error('请先在工作台完成连接配置');
  if (config.mode === 'direct' && config.adoBase) {
    const { directComment } = await import('./adoDirect');
    await directComment(
      { adoBase: config.adoBase, pat: config.pat ?? '', auth: config.auth },
      id,
      text,
      config.account,
    );
    return;
  }
  const res = await fetch(`${config.bridge}/api/ado/workitem/${id}/comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, author: config.account }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `评论失败（${res.status}）`);
  }
}
