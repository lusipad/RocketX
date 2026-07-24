/**
 * Azure DevOps Server 2022 直连客户端（不经 ado-bridge）。
 * 桌面端走 Tauri Rust 通道没有 CORS 限制，可直接连内网 ADO；
 * Web 端仅当 ADO 服务器允许跨域时可用；Windows 集成认证只在桌面端提供。
 */
import { ensureHttpOrigin, httpFetch, isTauri } from './http';

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
          'Windows 集成认证只能在桌面客户端使用（浏览器的跨域规则不允许携带系统凭据）。网页端请填写 PAT。',
        );
      }
      ({ status, text } = await ntlmRequest(url, method, payload, contentType));
    } else {
      await ensureHttpOrigin(url);
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
        ? `无法连接 ${base(cfg)}（网页端可能受浏览器跨域限制，请改用桌面客户端）`
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
  'System.Parent',
  'System.State',
  'System.TeamProject',
  'System.AssignedTo',
  'System.ChangedDate',
  'Microsoft.VSTS.Common.Priority',
  // 截止日期。Agile/Scrum/CMMI 各模板的叫法不一样，能拿到哪个算哪个：
  // Scheduling.DueDate（Bug/Task 常用）、Scheduling.TargetDate（Feature/Epic）、
  // Scheduling.FinishDate（CMMI）。实测本机 Server 2022 三个都存在于字段定义里。
  'Microsoft.VSTS.Scheduling.DueDate',
  'Microsoft.VSTS.Scheduling.TargetDate',
  'Microsoft.VSTS.Scheduling.FinishDate',
].join(',');

function mapWorkItem(cfg: DirectConfig, w: { id: number; fields: Record<string, any> }) {
  return {
    id: w.id,
    parentId: w.fields['System.Parent'],
    title: w.fields['System.Title'] ?? '',
    type: w.fields['System.WorkItemType'] ?? '',
    state: w.fields['System.State'] ?? '',
    priority: w.fields['Microsoft.VSTS.Common.Priority'],
    project: w.fields['System.TeamProject'] ?? '',
    assignedTo: w.fields['System.AssignedTo']?.displayName ?? w.fields['System.AssignedTo'],
    changedDate: w.fields['System.ChangedDate'],
    dueDate:
      w.fields['Microsoft.VSTS.Scheduling.DueDate'] ??
      w.fields['Microsoft.VSTS.Scheduling.TargetDate'] ??
      w.fields['Microsoft.VSTS.Scheduling.FinishDate'],
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
): Promise<{ id: string; displayName: string; account: string }> {
  const res = await adoRequest<{
    authenticatedUser?: {
      id?: string;
      providerDisplayName?: string;
      customDisplayName?: string;
      properties?: { Account?: { $value?: string } };
    };
  }>(cfg, 'GET', '/_apis/connectionData?api-version=7.0-preview');
  const u = res.authenticatedUser ?? {};
  const displayName = u.customDisplayName || u.providerDisplayName || '';
  return {
    // GUID：给 PR/构建的服务端过滤用（creatorId/reviewerId/requestedFor）——
    // 比账号字符串匹配可靠得多，字符串格式(域\名/邮箱/显示名)经常对不上
    id: u.id ?? '',
    displayName,
    account: u.properties?.Account?.$value || displayName,
  };
}

/** identity 缓存：一次会话内不用反复打 connectionData。按 adoBase 键控，换服务器自动失效 */
let identityCache: { key: string; me: { id: string; displayName: string; account: string } } | null =
  null;
export async function directGetMe(cfg: DirectConfig) {
  if (identityCache?.key !== cfg.adoBase) {
    identityCache = { key: cfg.adoBase, me: await directGetIdentity(cfg) };
  }
  return identityCache.me;
}

/**
 * 我的工作项：恒用 @Me 宏（服务器解析「我」，
 * 账号字符串匹配格式经常对不上，会把「我的十几个」漏成几个）。
 */
export async function directGetWorkItems(cfg: DirectConfig, _assignedTo = '', top = 100) {
  const notDone =
    `[System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved', '已关闭', '已完成', '已删除', '已移除', '已解决', '已修复')`;

  const result = await adoRequest<{ workItems?: { id: number }[] }>(
    cfg,
    'POST',
    `/_apis/wit/wiql?api-version=7.0&$top=${top}`,
    { query: `SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND ${notDone} ORDER BY [System.ChangedDate] DESC` },
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

export async function directGetProjects(cfg: DirectConfig): Promise<string[]> {
  const pageSize = 100;
  const projects: string[] = [];
  for (let skip = 0; ; skip += pageSize) {
    const res = await adoRequest<{ value: { name: string }[] }>(
      cfg,
      'GET',
      `/_apis/projects?api-version=7.0&$top=${pageSize}&$skip=${skip}`,
    );
    const page = res.value ?? [];
    projects.push(...page.map((project) => project.name));
    if (page.length < pageSize) break;
  }
  return projects.sort();
}

/** 当前项目实际启用的工作项类型；不同过程模板（Basic/Agile/Scrum/CMMI）并不相同。 */
export async function directGetWorkItemTypes(
  cfg: DirectConfig,
  project: string,
): Promise<string[]> {
  const res = await adoRequest<{ value: { name: string; isDisabled?: boolean }[] }>(
    cfg,
    'GET',
    `/${encodeURIComponent(project)}/_apis/wit/workitemtypes?api-version=7.0`,
  );
  return (res.value ?? []).filter((t) => !t.isDisabled).map((t) => t.name);
}

interface WorkItemCategory {
  workItemTypes?: { name: string }[];
}

/**
 * 项目过程配置里的真实层级（Portfolio → Requirement → Task）。
 * 与类型列表分开读取：类型列表决定“能不能创建”，这里仅决定层级模板怎么排列。
 */
export async function directGetWorkItemHierarchy(
  cfg: DirectConfig,
  project: string,
): Promise<string[]> {
  const res = await adoRequest<{
    portfolioBacklogs?: WorkItemCategory[];
    requirementBacklog?: WorkItemCategory;
    taskBacklog?: WorkItemCategory;
  }>(
    cfg,
    'GET',
    `/${encodeURIComponent(project)}/_apis/work/processconfiguration?api-version=7.0`,
  );
  const categories = [
    ...(res.portfolioBacklogs ?? []),
    res.requirementBacklog,
    res.taskBacklog,
  ];
  const seen = new Set<string>();
  return categories.flatMap((category) => {
    const name = category?.workItemTypes?.[0]?.name?.trim();
    if (!name || seen.has(name.toLocaleLowerCase())) return [];
    seen.add(name.toLocaleLowerCase());
    return [name];
  });
}

export async function directGetCurrentIteration(cfg: DirectConfig, project: string, team?: string): Promise<string | null> {
  const t = team ? `/${encodeURIComponent(team)}` : '';
  try {
    const res = await adoRequest<{ value: { path: string; attributes?: { timeFrame?: string } }[] }>(
      cfg, 'GET',
      `/${encodeURIComponent(project)}${t}/_apis/work/teamsettings/iterations?$timeframe=current&api-version=7.0`,
    );
    const cur = (res.value ?? []).find((it) => it.attributes?.timeFrame === 'current');
    return cur?.path ?? (res.value?.[0]?.path ?? null);
  } catch {
    return null;
  }
}

export interface CreateWorkItemOpts {
  description?: string;
  tags?: string;
  iterationPath?: string;
  parentId?: number;
}

export interface CreateWorkItemRequest {
  path: string;
  body: { op: string; path: string; value: any }[];
  contentType: 'application/json-patch+json';
}

/** ADO 创建工作项的可测试请求契约；路径中的类型始终来自项目实际类型名。 */
export function createWorkItemRequest(
  cfg: DirectConfig,
  project: string,
  type: string,
  title: string,
  opts?: CreateWorkItemOpts,
): CreateWorkItemRequest {
  const projectName = project.trim();
  const typeName = type.trim();
  if (!projectName) throw new Error('项目不能为空');
  if (!typeName) throw new Error('工作项类型不能为空');

  const ops: { op: string; path: string; value: any }[] = [
    { op: 'add', path: '/fields/System.Title', value: title },
  ];
  if (opts?.description) ops.push({ op: 'add', path: '/fields/System.Description', value: opts.description });
  if (opts?.tags) ops.push({ op: 'add', path: '/fields/System.Tags', value: opts.tags });
  if (opts?.iterationPath) ops.push({ op: 'add', path: '/fields/System.IterationPath', value: opts.iterationPath });
  if (opts?.parentId != null) {
    ops.push({
      op: 'add',
      path: '/relations/-',
      value: {
        rel: 'System.LinkTypes.Hierarchy-Reverse',
        url: `${base(cfg)}/_apis/wit/workitems/${opts.parentId}`,
      },
    });
  }
  return {
    path: `/${encodeURIComponent(projectName)}/_apis/wit/workitems/$${encodeURIComponent(typeName)}?api-version=7.0`,
    body: ops,
    contentType: 'application/json-patch+json',
  };
}

export async function directCreateWorkItem(
  cfg: DirectConfig,
  project: string,
  type: string,
  title: string,
  opts?: CreateWorkItemOpts,
) {
  const request = createWorkItemRequest(cfg, project, type, title, opts);
  const result = await adoRequest<{ id: number; fields: Record<string, any> }>(
    cfg,
    'POST',
    request.path,
    request.body,
    request.contentType,
  );
  return mapWorkItem(cfg, result);
}

export interface UpdateWorkItemStateRequest {
  path: string;
  body: { op: string; path: string; value: string }[];
  contentType: 'application/json-patch+json';
}

/** ADO 改状态的可测试请求契约（看板拖拽用，issue #82） */
export function updateWorkItemStateRequest(id: number, state: string): UpdateWorkItemStateRequest {
  const value = state.trim();
  if (!Number.isInteger(id) || id <= 0) throw new Error('工作项编号无效');
  if (!value) throw new Error('目标状态不能为空');
  return {
    path: `/_apis/wit/workitems/${id}?api-version=7.0`,
    body: [{ op: 'add', path: '/fields/System.State', value }],
    contentType: 'application/json-patch+json',
  };
}

/**
 * 改工作项状态。状态是否是该类型的合法值、流转是否被过程模板允许，
 * 都由服务端裁决——非法流转 ADO 会 400，错误信息原样抛给调用方展示。
 */
export async function directUpdateWorkItemState(cfg: DirectConfig, id: number, state: string) {
  const request = updateWorkItemStateRequest(id, state);
  const result = await adoRequest<{ id: number; fields: Record<string, any> }>(
    cfg,
    'PATCH',
    request.path,
    request.body,
    request.contentType,
  );
  return mapWorkItem(cfg, result);
}

export interface CascadeTemplateItem {
  type: string;
  title: string;
  parent?: number;
}

export async function directCreateCascade(
  cfg: DirectConfig,
  project: string,
  template: CascadeTemplateItem[],
  vars: Record<string, string>,
  opts?: { tags?: string; iterationPath?: string },
) {
  const resolve = (s: string) => s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
  const created: { id: number; type: string; title: string; webUrl: string }[] = [];
  for (const item of template) {
    const title = resolve(item.title);
    const type = resolve(item.type);
    const parent = item.parent != null ? created[item.parent] : undefined;
    if (item.parent != null && !parent) {
      throw new Error(`层级模板第 ${created.length + 1} 项引用了无效父项 ${item.parent + 1}`);
    }
    const wi = await directCreateWorkItem(cfg, project, type, title, {
      tags: item.parent == null ? opts?.tags : undefined,
      iterationPath: opts?.iterationPath,
      parentId: parent?.id,
    });
    created.push({ id: wi.id, type: wi.type, title: wi.title, webUrl: wi.webUrl });
  }
  return created;
}

function mapPullRequest(cfg: DirectConfig, pr: any) {
  const project = pr.repository?.project?.name ?? '';
  const repo = pr.repository?.name ?? '';
  return {
    id: pr.pullRequestId,
    title: pr.title ?? '',
    repo,
    project,
    creator: pr.createdBy?.displayName ?? '',
    creatorUnique: pr.createdBy?.uniqueName ?? '',
    reviewers: (pr.reviewers ?? []).map((reviewer: any) => ({
      name: reviewer.displayName ?? '',
      unique: reviewer.uniqueName ?? '',
      vote: reviewer.vote ?? 0,
      isRequired: reviewer.isRequired === true,
      isContainer: reviewer.isContainer === true,
    })),
    sourceBranch: (pr.sourceRefName ?? '').replace('refs/heads/', ''),
    targetBranch: (pr.targetRefName ?? '').replace('refs/heads/', ''),
    createdDate: pr.creationDate ?? '',
    webUrl: `${base(cfg)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}/pullrequest/${pr.pullRequestId}`,
  };
}

export async function directGetPullRequest(
  cfg: DirectConfig,
  id: number,
) {
  const pr = await adoRequest<any>(
    cfg,
    'GET',
    `/_apis/git/pullrequests/${id}?api-version=7.0`,
  );
  return mapPullRequest(cfg, pr);
}

export async function directGetPullRequests(cfg: DirectConfig, pageSize = 100) {
  /**
   * 按用户 GUID 让服务端直接过滤，取代「拉全集合再前端按账号字符串匹配」：
   *  - 待我评审：reviewerId=我 且 active
   *  - 我提的  ：creatorId=我 且 active，工作台不展示已经完成或放弃的 PR
   * 前端的字符串匹配只保留给旧快照展示，不参与服务端查询。
   */
  const me = await directGetMe(cfg);
  const fetchPrs = async (criteria: string) => {
    const acc: any[] = [];
    for (let skip = 0; ; skip += pageSize) {
      const res = await adoRequest<{ value: any[] }>(
        cfg,
        'GET',
        `/_apis/git/pullrequests?${criteria}&$top=${pageSize}&$skip=${skip}&api-version=7.0`,
      );
      const page = res.value ?? [];
      acc.push(...page);
      if (page.length < pageSize) break;
    }
    return acc;
  };

  const [review, mine] = await Promise.all([
    fetchPrs(`searchCriteria.reviewerId=${me.id}&searchCriteria.status=active`),
    fetchPrs(`searchCriteria.creatorId=${me.id}&searchCriteria.status=active`),
  ]);
  const rel = new Map<number, 'mine' | 'review' | 'both'>();
  for (const pr of review) rel.set(pr.pullRequestId, 'review');
  for (const pr of mine)
    rel.set(pr.pullRequestId, rel.has(pr.pullRequestId) ? 'both' : 'mine');
  const seen = new Set<number>();
  const all = [...review, ...mine].filter((pr) =>
    seen.has(pr.pullRequestId) ? false : (seen.add(pr.pullRequestId), true),
  );
  return all.map((pr) => ({ ...mapPullRequest(cfg, pr), rel: rel.get(pr.pullRequestId) }));
}

function mapBuild(cfg: DirectConfig, build: any) {
  const project = build.project?.name ?? '';
  return {
    id: build.id,
    buildNumber: build.buildNumber ?? String(build.id),
    definition: build.definition?.name ?? '',
    project,
    status: build.status ?? '',
    result: build.result ?? '',
    requestedFor: build.requestedFor?.displayName ?? '',
    queueTime: build.queueTime ?? '',
    finishTime: build.finishTime ?? '',
    webUrl:
      build._links?.web?.href ??
      `${base(cfg)}/${encodeURIComponent(project)}/_build/results?buildId=${build.id}`,
  };
}

export async function directGetBuild(cfg: DirectConfig, project: string, id: number) {
  const build = await adoRequest<any>(
    cfg,
    'GET',
    `/${encodeURIComponent(project)}/_apis/build/builds/${id}?api-version=7.0`,
  );
  return mapBuild(cfg, build);
}

export async function directGetBuilds(cfg: DirectConfig, top = 20) {
  // 「我最近发起的构建」：requestedFor=我的GUID 由服务端过滤 + queueTime 倒序。
  // 项目要**全部**遍历——之前只看前 5 个项目，用户的项目不在里面就永远显示别处的老构建
  const me = await directGetMe(cfg);
  const projects = await directGetProjects(cfg);
  const lists: any[][] = [];
  for (let i = 0; i < projects.length; i += 8) {
    lists.push(
      ...(await Promise.all(
        projects.slice(i, i + 8).map(async (project) => {
          try {
            const res = await adoRequest<{ value: any[] }>(
              cfg,
              'GET',
              `/${encodeURIComponent(project)}/_apis/build/builds?requestedFor=${encodeURIComponent(me.id)}&$top=10&queryOrder=queueTimeDescending&api-version=7.0`,
            );
            return res.value ?? [];
          } catch {
            return [];
          }
        }),
      )),
    );
  }
  return lists
    .flat()
    .map((build) => mapBuild(cfg, build))
    .sort((a, b) => (b.queueTime > a.queueTime ? 1 : -1))
    .slice(0, top);
}

export async function directRunSavedQuery(
  cfg: DirectConfig,
  queryId: string,
  project?: string,
  top = 200,
) {
  const prefix = project ? `/${encodeURIComponent(project)}` : '';
  const result = await adoRequest<{
    workItems?: { id: number }[];
    workItemRelations?: { target?: { id: number } }[];
  }>(cfg, 'GET', `${prefix}/_apis/wit/wiql/${queryId}?api-version=7.0`);
  const rawIds = result.workItems
    ? result.workItems.map((w) => w.id)
    : (result.workItemRelations ?? [])
        .map((r) => r.target?.id)
        .filter((id): id is number => id != null);
  const ids = Array.from(new Set(rawIds)).slice(0, top);
  if (ids.length === 0) return [];
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200));
  const all = await Promise.all(
    chunks.map((chunk) =>
      adoRequest<{ value: { id: number; fields: Record<string, any> }[] }>(
        cfg,
        'GET',
        `/_apis/wit/workitems?ids=${chunk.join(',')}&fields=${WI_FIELDS}&api-version=7.0`,
      ).then((r) => (r.value ?? []).map((w) => mapWorkItem(cfg, w))),
    ),
  );
  const idOrder = new Map(ids.map((id, i) => [id, i]));
  return all.flat().sort((a, b) => (idOrder.get(a.id) ?? 0) - (idOrder.get(b.id) ?? 0));
}
