/**
 * Azure DevOps Server 2022 直连客户端（不经 ado-bridge）。
 * 桌面端走 Tauri Rust 通道没有 CORS 限制，可直接连内网 ADO；
 * Web 端仅当 ADO 服务器允许跨域时可用，否则请用桥接模式。
 */
import { httpFetch } from './client';

export interface DirectConfig {
  /** 集合地址，如 http://ado:8080/tfs/DefaultCollection */
  adoBase: string;
  pat: string;
}

function base(cfg: DirectConfig): string {
  return cfg.adoBase.replace(/\/+$/, '');
}

/** PAT 里可能有非 ASCII 字符，btoa 只吃 latin1 —— 先按 UTF-8 编码 */
function basicAuth(pat: string): string {
  const bytes = new TextEncoder().encode(`:${pat}`);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `Basic ${btoa(binary)}`;
}

async function adoRequest<T>(
  cfg: DirectConfig,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  contentType = 'application/json',
): Promise<T> {
  const url = `${base(cfg)}${path}`;
  let res: Response;
  try {
    res = await httpFetch(url, {
      method,
      headers: {
        'Content-Type': contentType,
        Accept: 'application/json',
        Authorization: basicAuth(cfg.pat),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      /fetch|network|load failed/i.test(raw)
        ? `无法连接 ${base(cfg)}（网页端受浏览器跨域限制，请用桌面客户端或改用 ado-bridge 模式）`
        : raw,
    );
  }
  if (res.status === 401 || res.status === 203) {
    // ADO 认证失败常返回 203 + 登录页 HTML
    throw new Error('认证失败：请检查 PAT 是否正确、是否过期、是否有读取权限');
  }
  if (res.status === 404) {
    throw new Error(`地址不对：${url} 返回 404（集合地址通常形如 http://host:8080/tfs/DefaultCollection）`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ADO 返回 ${res.status}：${text.slice(0, 160) || path}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    // 认证失败时 ADO 会返回 HTML 登录页而非 JSON
    throw new Error(
      text.trimStart().startsWith('<')
        ? '返回了 HTML 而非 JSON：多半是 PAT 无效或地址指向了网页入口而非 API'
        : '响应解析失败',
    );
  }
}

/** 连接测试：返回可用的项目数量 */
export async function directTestConnection(cfg: DirectConfig): Promise<string> {
  const res = await adoRequest<{ count?: number; value: { name: string }[] }>(
    cfg,
    'GET',
    '/_apis/projects?api-version=7.0&$top=5',
  );
  const names = (res.value ?? []).map((p) => p.name);
  if (names.length === 0) throw new Error('连接成功但没有可见的项目（检查 PAT 权限范围）');
  return `连接成功，可见 ${res.count ?? names.length} 个项目：${names.slice(0, 3).join('、')}`;
}

const WI_FIELDS = [
  'System.Title',
  'System.WorkItemType',
  'System.State',
  'System.TeamProject',
  'System.AssignedTo',
  'System.ChangedDate',
  'Microsoft.VSTS.Common.Priority',
].join(',');

function mapWorkItem(cfg: DirectConfig, w: { id: number; fields: Record<string, any> }) {
  return {
    id: w.id,
    title: w.fields['System.Title'] ?? '',
    type: w.fields['System.WorkItemType'] ?? '',
    state: w.fields['System.State'] ?? '',
    priority: w.fields['Microsoft.VSTS.Common.Priority'],
    project: w.fields['System.TeamProject'] ?? '',
    assignedTo: w.fields['System.AssignedTo']?.displayName ?? w.fields['System.AssignedTo'],
    changedDate: w.fields['System.ChangedDate'],
    webUrl: `${base(cfg)}/${encodeURIComponent(w.fields['System.TeamProject'] ?? '')}/_workitems/edit/${w.id}`,
  };
}

export async function directGetWorkItems(cfg: DirectConfig, assignedTo: string, top = 50) {
  const who = assignedTo.replace(/'/g, "''");
  const wiql = {
    query:
      `SELECT [System.Id] FROM WorkItems ` +
      `WHERE [System.AssignedTo] = '${who}' ` +
      `AND [System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved') ` +
      `ORDER BY [System.ChangedDate] DESC`,
  };
  const result = await adoRequest<{ workItems?: { id: number }[] }>(
    cfg,
    'POST',
    `/_apis/wit/wiql?api-version=7.0&$top=${top}`,
    wiql,
  );
  const ids = (result.workItems ?? []).slice(0, top).map((w) => w.id);
  if (ids.length === 0) return [];
  const detail = await adoRequest<{ value: { id: number; fields: Record<string, any> }[] }>(
    cfg,
    'GET',
    `/_apis/wit/workitems?ids=${ids.join(',')}&fields=${WI_FIELDS}&api-version=7.0`,
  );
  return (detail.value ?? []).map((w) => mapWorkItem(cfg, w));
}

export async function directGetWorkItem(cfg: DirectConfig, id: number) {
  const detail = await adoRequest<{ value: { id: number; fields: Record<string, any> }[] }>(
    cfg,
    'GET',
    `/_apis/wit/workitems?ids=${id}&fields=${WI_FIELDS}&api-version=7.0`,
  );
  const w = detail.value?.[0];
  return w ? mapWorkItem(cfg, w) : null;
}

export async function directComment(
  cfg: DirectConfig,
  id: number,
  text: string,
  author?: string,
): Promise<void> {
  const value = author ? `[来自 RocketX，${author}]<br/>${text}` : text;
  await adoRequest(
    cfg,
    'PATCH',
    `/_apis/wit/workitems/${id}?api-version=7.0`,
    [{ op: 'add', path: '/fields/System.History', value }],
    'application/json-patch+json',
  );
}

export async function directGetPullRequests(cfg: DirectConfig, top = 100) {
  const res = await adoRequest<{ value: any[] }>(
    cfg,
    'GET',
    `/_apis/git/pullrequests?searchCriteria.status=active&$top=${top}&api-version=7.0`,
  );
  return (res.value ?? []).map((pr) => {
    const project = pr.repository?.project?.name ?? '';
    const repo = pr.repository?.name ?? '';
    return {
      id: pr.pullRequestId,
      title: pr.title ?? '',
      repo,
      project,
      creator: pr.createdBy?.displayName ?? '',
      creatorUnique: pr.createdBy?.uniqueName ?? '',
      reviewers: (pr.reviewers ?? []).map((r: any) => ({
        name: r.displayName ?? '',
        unique: r.uniqueName ?? '',
        vote: r.vote ?? 0,
      })),
      sourceBranch: (pr.sourceRefName ?? '').replace('refs/heads/', ''),
      targetBranch: (pr.targetRefName ?? '').replace('refs/heads/', ''),
      createdDate: pr.creationDate ?? '',
      webUrl: `${base(cfg)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}/pullrequest/${pr.pullRequestId}`,
    };
  });
}

export async function directGetBuilds(cfg: DirectConfig, top = 15) {
  const projects = await adoRequest<{ value: { name: string }[] }>(
    cfg,
    'GET',
    '/_apis/projects?api-version=7.0&$top=10',
  );
  const lists = await Promise.all(
    (projects.value ?? []).slice(0, 5).map(async (p) => {
      try {
        const res = await adoRequest<{ value: any[] }>(
          cfg,
          'GET',
          `/${encodeURIComponent(p.name)}/_apis/build/builds?$top=10&api-version=7.0`,
        );
        return res.value ?? [];
      } catch {
        return [];
      }
    }),
  );
  return lists
    .flat()
    .map((b) => ({
      id: b.id,
      buildNumber: b.buildNumber ?? String(b.id),
      definition: b.definition?.name ?? '',
      project: b.project?.name ?? '',
      status: b.status ?? '',
      result: b.result ?? '',
      requestedFor: b.requestedFor?.displayName ?? '',
      queueTime: b.queueTime ?? '',
      finishTime: b.finishTime ?? '',
      webUrl:
        b._links?.web?.href ??
        `${base(cfg)}/${encodeURIComponent(b.project?.name ?? '')}/_build/results?buildId=${b.id}`,
    }))
    .sort((a, b) => (b.queueTime > a.queueTime ? 1 : -1))
    .slice(0, top);
}
