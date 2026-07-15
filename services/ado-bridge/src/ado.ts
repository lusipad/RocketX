/**
 * Azure DevOps Server 2022 REST API 客户端（api-version=7.0）。
 * 用 PAT 做 Basic 认证，只读查询：工作项（WIQL）与活跃 PR。
 */

export interface AdoConfig {
  /**
   * ADO 集合地址。不同部署形态都支持：
   *   http://ado:8080/DefaultCollection        （无虚拟目录）
   *   http://ado:8080/tfs/DefaultCollection    （有 tfs 虚拟目录）
   *   http://ado:8080/tfs/MyCollection         （自定义集合名）
   */
  baseUrl: string;
  /** 留空则不带凭据（内网 Windows 集成认证场景） */
  pat: string;
}

export interface AdoWorkItem {
  id: number;
  title: string;
  type: string;
  state: string;
  priority?: number;
  project: string;
  assignedTo?: string;
  changedDate?: string;
  webUrl: string;
}

export interface AdoBuild {
  id: number;
  buildNumber: string;
  definition: string;
  project: string;
  status: string;
  result: string;
  requestedFor: string;
  queueTime: string;
  finishTime: string;
  webUrl: string;
}

export interface AdoPullRequest {
  id: number;
  title: string;
  repo: string;
  project: string;
  creator: string;
  creatorUnique: string;
  reviewers: { name: string; unique: string; vote: number }[];
  sourceBranch: string;
  targetBranch: string;
  createdDate: string;
  webUrl: string;
}

export class AdoClient {
  constructor(private config: AdoConfig) {}

  get webBase(): string {
    return this.config.baseUrl.replace(/\/+$/, '');
  }

  /** PAT 为空时不带 Authorization（走 Windows 集成认证） */
  private authHeaders(): Record<string, string> {
    if (!this.config.pat) return {};
    return {
      Authorization: `Basic ${Buffer.from(`:${this.config.pat}`).toString('base64')}`,
    };
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = `${this.webBase}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...this.authHeaders(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ADO ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    }
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(
        text.trimStart().startsWith('<')
          ? `ADO 返回 HTML 而非 JSON（认证被重定向到登录页，或 ADO_BASE_URL 不是集合根）：${url}`
          : `ADO 响应解析失败：${url}`,
      );
    }
  }

  /** 分配给某人的未关闭工作项（按最近变更排序） */
  async getWorkItems(assignedTo = '', top = 50): Promise<AdoWorkItem[]> {
    // WIQL 里单引号转义为两个单引号
    const who = assignedTo.replace(/'/g, "''");
    const assignee = who ? `'${who}'` : '@Me';
    const wiql = {
      query:
        `SELECT [System.Id] FROM WorkItems ` +
        `WHERE [System.AssignedTo] = ${assignee} ` +
        // 中文流程模板的状态是中文名，只排英文会把已完成的全拉回来
        `AND [System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved', '已关闭', '已完成', '已删除', '已移除', '已解决', '已修复') ` +
        `ORDER BY [System.ChangedDate] DESC`,
    };
    const result = await this.request<{ workItems?: { id: number }[] }>(
      'POST',
      '/_apis/wit/wiql?api-version=7.0&$top=' + top,
      wiql,
    );
    const ids = (result.workItems ?? []).slice(0, top).map((w) => w.id);
    if (ids.length === 0) return [];

    const fields = [
      'System.Title',
      'System.WorkItemType',
      'System.State',
      'System.TeamProject',
      'System.AssignedTo',
      'System.ChangedDate',
      'Microsoft.VSTS.Common.Priority',
    ].join(',');
    const detail = await this.request<{
      value: { id: number; fields: Record<string, any> }[];
    }>('GET', `/_apis/wit/workitems?ids=${ids.join(',')}&fields=${fields}&api-version=7.0`);

    return (detail.value ?? []).map((w) => ({
      id: w.id,
      title: w.fields['System.Title'] ?? '',
      type: w.fields['System.WorkItemType'] ?? '',
      state: w.fields['System.State'] ?? '',
      priority: w.fields['Microsoft.VSTS.Common.Priority'],
      project: w.fields['System.TeamProject'] ?? '',
      assignedTo: w.fields['System.AssignedTo']?.displayName ?? w.fields['System.AssignedTo'],
      changedDate: w.fields['System.ChangedDate'],
      webUrl: `${this.webBase}/${encodeURIComponent(w.fields['System.TeamProject'] ?? '')}/_workitems/edit/${w.id}`,
    }));
  }

  /** 单个工作项详情（悬停卡片用） */
  async getWorkItem(id: number): Promise<AdoWorkItem | null> {
    const fields = [
      'System.Title',
      'System.WorkItemType',
      'System.State',
      'System.TeamProject',
      'System.AssignedTo',
      'System.ChangedDate',
      'Microsoft.VSTS.Common.Priority',
    ].join(',');
    const detail = await this.request<{ value: { id: number; fields: Record<string, any> }[] }>(
      'GET',
      `/_apis/wit/workitems?ids=${id}&fields=${fields}&api-version=7.0`,
    );
    const w = detail.value?.[0];
    if (!w) return null;
    return {
      id: w.id,
      title: w.fields['System.Title'] ?? '',
      type: w.fields['System.WorkItemType'] ?? '',
      state: w.fields['System.State'] ?? '',
      priority: w.fields['Microsoft.VSTS.Common.Priority'],
      project: w.fields['System.TeamProject'] ?? '',
      assignedTo: w.fields['System.AssignedTo']?.displayName ?? w.fields['System.AssignedTo'],
      changedDate: w.fields['System.ChangedDate'],
      webUrl: `${this.webBase}/${encodeURIComponent(w.fields['System.TeamProject'] ?? '')}/_workitems/edit/${w.id}`,
    };
  }

  /**
   * 给工作项添加讨论评论。走 System.History 字段的 JSON Patch，
   * 这是 ADO Server 2022 的稳定 API（comments 接口在 Server 上还是 preview）。
   */
  async addWorkItemComment(id: number, text: string, author?: string): Promise<void> {
    const value = author ? `[来自 RocketX，${author}]<br/>${text}` : text;
    const url = `${this.webBase}/_apis/wit/workitems/${id}?api-version=7.0`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json-patch+json',
        ...this.authHeaders(),
      },
      body: JSON.stringify([{ op: 'add', path: '/fields/System.History', value }]),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ADO 评论失败: ${res.status} ${body.slice(0, 200)}`);
    }
  }

  /** 各项目最近构建（合并排序，工作台构建面板用） */
  async getRecentBuilds(top = 15): Promise<AdoBuild[]> {
    const projects = await this.request<{ value: { name: string }[] }>(
      'GET',
      '/_apis/projects?api-version=7.0&$top=10',
    );
    const lists = await Promise.all(
      (projects.value ?? []).slice(0, 5).map(async (p) => {
        try {
          const res = await this.request<{ value: any[] }>(
            'GET',
            // queryOrder 倒序：拿最近触发的，不加会返回最旧的 N 条（issue #17.3）
            `/${encodeURIComponent(p.name)}/_apis/build/builds?$top=10&queryOrder=queueTimeDescending&api-version=7.0`,
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
          `${this.webBase}/${encodeURIComponent(b.project?.name ?? '')}/_build/results?buildId=${b.id}`,
      }))
      .sort((a, b) => (b.queueTime > a.queueTime ? 1 : -1))
      .slice(0, top);
  }

  /** 集合内全部活跃 PR（客户端按创建人/评审人过滤） */
  async getActivePullRequests(pageSize = 100): Promise<AdoPullRequest[]> {
    // 单页最多 100 条，$skip 翻页拉全，否则超过 100 个活跃 PR 时会漏（issue #17.2）
    const all: any[] = [];
    for (let skip = 0; skip < 2000; skip += pageSize) {
      const res = await this.request<{ value: any[] }>(
        'GET',
        `/_apis/git/pullrequests?searchCriteria.status=active&$top=${pageSize}&$skip=${skip}&api-version=7.0`,
      );
      const page = res.value ?? [];
      all.push(...page);
      if (page.length < pageSize) break;
    }
    return all.map((pr) => {
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
        webUrl: `${this.webBase}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}/pullrequest/${pr.pullRequestId}`,
      };
    });
  }
}
