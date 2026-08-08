import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServerClient } from '../apps/web/src/agent/protocol/client';
import type { PluginInstalledParams } from '../apps/web/src/agent/protocol/generated/v2/PluginInstalledParams';
import type { PluginInstalledResponse } from '../apps/web/src/agent/protocol/generated/v2/PluginInstalledResponse';
import type { PluginListParams } from '../apps/web/src/agent/protocol/generated/v2/PluginListParams';
import type { PluginListResponse } from '../apps/web/src/agent/protocol/generated/v2/PluginListResponse';
import {
  codexInvocation,
  NodeCodexTransport,
  removeSpikeTempRoot,
  type SpikeCodexRuntimeSource,
} from './lib/codex-app-server-spike';

interface PluginProbeResult {
  source: SpikeCodexRuntimeSource;
  version: string;
  path: string;
  marketplaces: number;
  installedMarketplaces: number;
  loadErrors: number;
}

function assertPluginListResponse(
  method: 'plugin/list' | 'plugin/installed',
  value: PluginListResponse | PluginInstalledResponse,
): void {
  if (!Array.isArray(value.marketplaces) || !Array.isArray(value.marketplaceLoadErrors)) {
    throw new Error(`${method} 返回了无效市场列表`);
  }
}

async function probeRuntime(source: SpikeCodexRuntimeSource): Promise<PluginProbeResult> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'rocketx-plugin-marketplace-'));
  const codexHome = join(tempRoot, 'codex-home');
  const workspaceRoot = join(tempRoot, 'workspace');
  await Promise.all([
    mkdir(codexHome, { recursive: true }),
    mkdir(workspaceRoot, { recursive: true }),
  ]);

  const invocation = codexInvocation(source);
  const transport = new NodeCodexTransport(workspaceRoot, invocation, { codexHome });
  const client = new AppServerClient(transport);
  try {
    await client.start();
    const list = await client.request(
      'plugin/list',
      { cwds: [workspaceRoot] } satisfies PluginListParams,
      30_000,
    );
    const installed = await client.request(
      'plugin/installed',
      {
        cwds: [workspaceRoot],
        installSuggestionPluginNames: [],
      } satisfies PluginInstalledParams,
      30_000,
    );
    assertPluginListResponse('plugin/list', list);
    assertPluginListResponse('plugin/installed', installed);
    return {
      source,
      version: invocation.version,
      path: invocation.displayPath,
      marketplaces: list.marketplaces.length,
      installedMarketplaces: installed.marketplaces.length,
      loadErrors: list.marketplaceLoadErrors.length + installed.marketplaceLoadErrors.length,
    };
  } finally {
    await client.stop().catch(() => undefined);
    await removeSpikeTempRoot(tempRoot, 'rocketx-plugin-marketplace-');
  }
}

async function main(): Promise<void> {
  const results: PluginProbeResult[] = [];
  for (const source of ['pinned', 'system'] as const) {
    results.push(await probeRuntime(source));
  }
  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
