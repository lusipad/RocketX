/**
 * Azure DevOps Server 2022 直连客户端（不经 ado-bridge）。
 * 桌面端走 Tauri Rust 通道没有 CORS 限制，可直接连内网 ADO；
 * Web 端仅当 ADO 服务器允许跨域时可用，否则请用桥接模式。
 */
import { httpFetch, isTauri } from './http';

/** 认证方式。企业内网的 ADO Server 默认是 Windows 集成认证，所以 ntlm 排在最前。 */
export type AdoAuth = 'ntlm' | 'pat' | 'bearer' | 'none';

export interface DirectConfig {
  /** 集合地址，如 http://ado:8080/DefaultCollection 或 http://ado:8080/tfs/DefaultCollection */
  adoBase: string;
  pat: string;
  /**
   * ntlm   = Windows 集成认证，用当前登录用户的凭据，不需要 PAT（仅桌面端；见下方说明）
   * pat    = Basic(:PAT)
   * bearer = Bearer PAT
   * none   = 不带任何凭据
   */
  auth?: AdoAuth;
}

/** ntlm 只能在桌面端用：浏览器跨域带凭据要求服务端回显具体 Origin，而 ADO 回的是 `*` */
export const canUseNtlm = isTauri;

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

/**
 * Windows 集成认证走 Rust 侧的 WinHTTP。
 *
 * 为什么不能在前端做：带 NTLM 凭据的跨源请求需要 `credentials: 'include'`，
 * 而 CORS 规定这时服务端不能回 `Access-Control-Allow-Origin: *` —— ADO 回的正是 `*`。
 * 所以只能绕开 webview，由 WinHTTP 用当前登录用户的凭据完成挑战-应答。
 */
async function ntlmRequest(
  url: string,
  method: string,
  body: string | undefined,
  contentType: string,
): Promise<{ status: number; text: string }> {
  const { invoke } = await import('@tauri-apps/api/core');
  const res = await invoke<{ status: number; body: string }>('win_auth_request', {
    url,
    method,
    body,
    contentType,
  });
  return { status: res.status, text: res.body };
}

async function adoRequest<T>(
  cfg: DirectConfig,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  contentType = 'application/json',
): Promise<T> {
  const url = `${base(cfg)}${path}`;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  let status: number;
  let text: string;

  try {
    if (cfg.auth === 'ntlm') {
      if (!canUseNtlm) {
        throw new Error(
          'Windows 集成认证只能在桌面客户端使用（浏览器的跨域规则不允许携带系统凭据）。网页端请填 PAT 或改用桥接模式。',
        );
      }
      ({ status, text } = await ntlmRequest(url, method, payload, contentType));
    } else {
      const res = await httpFetch(url, {
        method,
        headers: {
          'Content-Type': contentType,
          Accept: 'application/json',
          ...authHeaders(cfg),
        },
        body: payload,
      });
      status = res.status;
      text = await res.text();
    }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    if (/只能在桌面客户端/.test(raw)) throw err;
    throw new Error(
      /fetch|network|load failed/i.test(raw)
        ? `无法连接 ${base(cfg)}（网页端受浏览器跨域限制，请用桌面客户端或改用 ado-bridge 模式）`
        : raw,
    );
  }

  if (status === 401 || status === 203) {
    // 三种情况的处理方向完全不同，提示必须分开说，否则用户会一直去改 PAT
    throw new Error(
      cfg.auth === 'ntlm'
        ? 'Windows 集成认证被拒：当前登录用户在该 Azure DevOps 上没有权限，或服务器未启用 NTLM/Negotiate'
        : cfg.auth === 'none' || !cfg.pat?.trim()
          ? '服务器要求认证：桌面端可用 Windows 集成认证（自动探测会试），网页端请填 PAT'
          : '认证失败：PAT 无效、已过期、或权限不足（需要 Work Items / Code / Build 读取）',
    );
  }
  if (status === 404) {
    throw new Error(`地址不对：${url} 返回 404`);
  }
  if (status < 200 || status >= 300) {
    throw new Error(`ADO 返回 ${status}：${text.slice(0, 160) || path}`);
  }
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
  auth: AdoAuth;
  ok: boolean;
  detail: string;
};

export interface ProbeResult {
  steps: ProbeStep[];
  /** 探测成功时的可用配置 */
  found?: { adoBase: string; auth: AdoAuth; projects: string[] };
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
  /**
   * 顺序即优先级。桌面端把 Windows 集成认证放最前：企业内网的 ADO Server 默认就是它，
   * 用户什么都不填就该能连上——不该逼人先去建 PAT。
   * 网页端做不了 NTLM（跨域带凭据的限制），直接跳过。
   */
  const authModes: AdoAuth[] = [
    ...(canUseNtlm ? (['ntlm'] as const) : []),
    ...(pat.trim() ? (['pat', 'bearer'] as const) : []),
    'none',
  ];
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

/**
 * 服务器认为「我是谁」。
 * Windows 集成认证下，账号是域账号（如 lus 或 CORP\lus），跟邮箱格式完全不一样——
 * 与其让用户猜该填什么，不如直接问服务器。
 */
export async function directGetIdentity(
  cfg: DirectConfig,
): Promise<{ displayName: string; account: string }> {
  const res = await adoRequest<{
    authenticatedUser?: {
      providerDisplayName?: string;
      customDisplayName?: string;
      properties?: { Account?: { $value?: string } };
    };
  }>(cfg, 'GET', '/_apis/connectionData?api-version=7.0-preview');
  const u = res.authenticatedUser ?? {};
  const displayName = u.customDisplayName || u.providerDisplayName || '';
  return {
    displayName,
    account: u.properties?.Account?.$value || displayName,
  };
}

/**
 * 我的工作项。
 *
 * assignedTo 留空时用 ADO 的 @Me 宏 —— 由服务器解析成「当前认证的这个人」，
 * 不用去猜他的账号是 lus、CORP\lus 还是 lus@corp.com。
 * 只有想看别人的工作项时才需要显式传账号。
 */
export async function directGetWorkItems(cfg: DirectConfig, assignedTo: string, top = 50) {
  const who = assignedTo.trim()
    ? `'${assignedTo.trim().replace(/'/g, "''")}'`
    : '@Me';
  const wiql = {
    query:
      `SELECT [System.Id] FROM WorkItems ` +
      `WHERE [System.AssignedTo] = ${who} ` +
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
