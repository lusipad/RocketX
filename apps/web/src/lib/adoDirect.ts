/**
 * Azure DevOps Server 2022 直连客户端（不经 ado-bridge）。
 * 桌面端走 Tauri Rust 通道没有 CORS 限制，可直接连内网 ADO；
 * Web 端仅当 ADO 服务器允许跨域时可用，否则请用桥接模式。
 */
import { httpFetch } from './http';

export interface DirectConfig {
  /** 集合地址，如 http://ado:8080/DefaultCollection 或 http://ado:8080/tfs/DefaultCollection */
  adoBase: string;
  pat: string;
  /** 认证方式：pat=Basic(:PAT)，bearer=Bearer PAT，none=不带凭据（Windows 集成认证由系统协商） */
  auth?: 'pat' | 'bearer' | 'none';
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

function authHeaders(cfg: DirectConfig): Record<string, string> {
  const mode = cfg.auth ?? 'pat';
  if (mode === 'none' || !cfg.pat) return {};
  if (mode === 'bearer') return { Authorization: `Bearer ${cfg.pat}` };
  return { Authorization: basicAuth(cfg.pat) };
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
        ...authHeaders(cfg),
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
    // 没填 PAT 和填了错 PAT 是两回事，提示得说清楚，否则用户会一直去改 PAT
    throw new Error(
      cfg.auth === 'none' || !cfg.pat?.trim()
        ? '服务器要求认证：请填写 PAT（在 ADO 的 用户设置 → 个人访问令牌 里创建，勾选 Work Items / Code / Build 读取权限）'
        : '认证失败：PAT 无效、已过期、或权限不足（需要 Work Items / Code / Build 读取）',
    );
  }
  if (res.status === 404) {
    throw new Error(`地址不对：${url} 返回 404`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ADO 返回 ${res.status}：${text.slice(0, 160) || path}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      text.trimStart().startsWith('<')
        ? '返回了 HTML 而非 JSON：认证被重定向到登录页，或地址不是 API 根'
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
  return `可见 ${res.count ?? names.length} 个项目：${names.slice(0, 3).join('、')}`;
}

// ---- 自动探测 ----

export type ProbeStep = {
  url: string;
  auth: 'pat' | 'bearer' | 'none';
  ok: boolean;
  detail: string;
};

export interface ProbeResult {
  steps: ProbeStep[];
  /** 探测成功时的可用配置 */
  found?: { adoBase: string; auth: 'pat' | 'bearer' | 'none'; projects: string[] };
}

/**
 * 从用户输入的任意 ADO 地址推导候选集合根。
 * 例：http://ado:8080/DefaultCollection/MyProject/_workitems/edit/128
 *  → http://ado:8080/DefaultCollection/MyProject
 *  → http://ado:8080/DefaultCollection   ← 集合根（通常是这个）
 *  → http://ado:8080
 * 顺带补上常见的 /tfs 变体。
 */
export function candidateBases(input: string): string[] {
  let raw = input.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return [];
  }

  const origin = url.origin;
  // 去掉 ADO 的功能段（_workitems / _git / _apis / _build …）之后的所有内容
  const segments = url.pathname.split('/').filter(Boolean);
  const funcIdx = segments.findIndex((s) => s.startsWith('_'));
  const meaningful = funcIdx >= 0 ? segments.slice(0, funcIdx) : segments;

  const bases: string[] = [];
  // 从最深逐级向上：.../Collection/Project → .../Collection → origin
  for (let i = meaningful.length; i >= 0; i--) {
    const path = meaningful.slice(0, i).join('/');
    bases.push(path ? `${origin}/${path}` : origin);
  }
  // 用户可能漏了虚拟目录，补上 /tfs 变体
  if (!meaningful.includes('tfs')) {
    const withTfs = meaningful.length
      ? `${origin}/tfs/${meaningful.join('/')}`
      : `${origin}/tfs/DefaultCollection`;
    bases.push(withTfs);
    if (meaningful.length > 1) bases.push(`${origin}/tfs/${meaningful[0]}`);
    bases.push(`${origin}/tfs`);
  }
  // 完全没写路径时，试常见默认集合
  if (meaningful.length === 0) {
    bases.push(`${origin}/DefaultCollection`, `${origin}/tfs/DefaultCollection`);
  }
  return [...new Set(bases)];
}

/**
 * 自动探测：对每个候选集合根 × 每种认证方式尝试 /_apis/projects，
 * 返回全过程（成功即停）。
 */
export async function probeAdo(
  input: string,
  pat: string,
  onStep?: (step: ProbeStep) => void,
): Promise<ProbeResult> {
  const bases = candidateBases(input);
  const authModes: ('pat' | 'bearer' | 'none')[] = pat.trim()
    ? ['pat', 'bearer', 'none']
    : ['none'];
  const steps: ProbeStep[] = [];

  for (const adoBase of bases) {
    for (const auth of authModes) {
      const url = `${adoBase}/_apis/projects?api-version=7.0&$top=5`;
      let step: ProbeStep;
      try {
        const res = await adoRequest<{ count?: number; value: { name: string }[] }>(
          { adoBase, pat, auth },
          'GET',
          '/_apis/projects?api-version=7.0&$top=5',
        );
        const projects = (res.value ?? []).map((p) => p.name);
        step = {
          url,
          auth,
          ok: true,
          detail: `成功，${res.count ?? projects.length} 个项目`,
        };
        steps.push(step);
        onStep?.(step);
        return { steps, found: { adoBase, auth, projects } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        step = { url, auth, ok: false, detail: msg };
        steps.push(step);
        onStep?.(step);
        // 连不上主机（网络/跨域）就没必要换认证方式重试
        if (/无法连接/.test(msg)) break;
      }
    }
  }
  return { steps };
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
