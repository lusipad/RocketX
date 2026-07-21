import { ensureHttpOrigin, httpFetch } from './http';
import { parseWorkspaceConfig, type WorkspaceConfig } from './workspaceConfig';

/** URL 来源统一入口：桌面端每次进程启动后都必须先登记 HTTP origin。 */
export async function fetchWorkspaceConfig(
  target: string,
  runtime: {
    ensureOrigin: typeof ensureHttpOrigin;
    fetch: typeof httpFetch;
  } = { ensureOrigin: ensureHttpOrigin, fetch: httpFetch },
): Promise<WorkspaceConfig> {
  const url = target.trim();
  await runtime.ensureOrigin(url);
  const response = await runtime.fetch(url);
  if (!response.ok) throw new Error(`团队配置返回 HTTP ${response.status}`);
  return parseWorkspaceConfig(await response.text());
}
