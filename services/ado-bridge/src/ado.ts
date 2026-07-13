/**
 * Azure DevOps Server 2022 REST API 客户端（api-version=7.0）。
 * 用 PAT 做 Basic 认证，只读查询：工作项（WIQL）与活跃 PR。
 */

export interface AdoConfig {
  /** 形如 http://ado-server:8080/tfs/DefaultCollection */
  baseUrl: string;
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

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = `${this.webBase}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`:${this.config.pat}`).toString('base64')}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ADO ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  /** 分配给某人的未关闭工作项（按最近变更排序） */
  async getWorkItems(assignedTo: string, top = 50): Promise<AdoWorkItem[]> {
    // WIQL 里单引号转义为两个单引号
    const who = assignedTo.replace(/'/g, "''");
    const wiql = {
      query:
        `SELECT [System.Id] FROM WorkItems ` +
        `WHERE [System.AssignedTo] = '${who}' ` +
        `AND [System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved') ` +
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
        Authorization: `Basic ${Buffer.from(`:${this.config.pat}`).toString('base64')}`,
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
          `${this.webBase}/${encodeURIComponent(b.project?.name ?? '')}/_build/results?buildId=${b.id}`,
      }))
      .sort((a, b) => (b.queueTime > a.queueTime ? 1 : -1))
      .slice(0, top);
  }

  /** 集合内全部活跃 PR（客户端按创建人/评审人过滤） */
  async getActivePullRequests(top = 100): Promise<AdoPullRequest[]> {
    const res = await this.request<{ value: any[] }>(
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
        webUrl: `${this.webBase}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}/pullrequest/${pr.pullRequestId}`,
      };
    });
  }
}
