/** 工作台（Azure DevOps）客户端侧：配置读写 + 经 ado-bridge 的查询 */

export const WORKBENCH_CONFIG_KEY = 'rcx-workbench';
/** markdown 渲染器用它把消息里的 #123 链接到 ADO 工作项 */
export const ADO_WEB_KEY = 'rcx-ado-web';

export interface WorkbenchConfig {
  bridge: string;
  account: string;
}

export function loadWorkbenchConfig(): WorkbenchConfig | null {
  try {
    const raw = localStorage.getItem(WORKBENCH_CONFIG_KEY);
    return raw ? (JSON.parse(raw) as WorkbenchConfig) : null;
  } catch {
    return null;
  }
}

export function saveWorkbenchConfig(config: WorkbenchConfig): void {
  localStorage.setItem(WORKBENCH_CONFIG_KEY, JSON.stringify(config));
}

export function adoWebBase(): string | null {
  return localStorage.getItem(ADO_WEB_KEY);
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

const itemCache = new Map<number, { item: AdoWorkItemInfo | null; ts: number }>();
const inflight = new Map<number, Promise<AdoWorkItemInfo | null>>();
const CACHE_TTL = 60_000;

/** 悬停卡片查询：60s 缓存 + 并发去重；未配置工作台返回 null */
export function fetchWorkItem(id: number): Promise<AdoWorkItemInfo | null> {
  const config = loadWorkbenchConfig();
  if (!config) return Promise.resolve(null);

  const cached = itemCache.get(id);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return Promise.resolve(cached.item);

  const existing = inflight.get(id);
  if (existing) return existing;

  const promise = fetch(`${config.bridge}/api/ado/workitem/${id}`)
    .then(async (res) => {
      const item = res.ok ? ((await res.json()) as { item: AdoWorkItemInfo }).item : null;
      itemCache.set(id, { item, ts: Date.now() });
      return item;
    })
    .catch(() => {
      itemCache.set(id, { item: null, ts: Date.now() });
      return null;
    })
    .finally(() => inflight.delete(id));
  inflight.set(id, promise);
  return promise;
}

export async function commentWorkItem(id: number, text: string): Promise<void> {
  const config = loadWorkbenchConfig();
  if (!config) throw new Error('请先在工作台完成连接配置');
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
