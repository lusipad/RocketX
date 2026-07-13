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
