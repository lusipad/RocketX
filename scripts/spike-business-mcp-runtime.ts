import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { AppServerClient } from '../apps/web/src/agent/protocol/client';
import {
  codexInvocation,
  codexRuntimeSourceFromArgs,
  NodeCodexTransport,
  removeSpikeTempRoot,
  type SpikeCodexRuntimeSource,
} from './lib/codex-app-server-spike';

const SERVER_NAME = 'rocketx_business';
const EXPECTED_TOOLS = [
  'rocketx_azure_devops_server_read',
  'rocketx_get_room_history',
  'rocketx_get_thread_context',
  'rocketx_list_conversations',
  'rocketx_search_messages',
  'rocketx_search_people_rooms',
];

function binaryPath(): string {
  const configured = process.env.ROCKETX_BUSINESS_MCP_BINARY?.trim();
  const candidate = configured
    ? (isAbsolute(configured) ? configured : resolve(configured))
    : resolve('apps/desktop/src-tauri/target/debug/rocketx.exe');
  if (!existsSync(candidate)) {
    throw new Error(`找不到 RocketX business MCP 可执行文件：${candidate}`);
  }
  return candidate;
}

function requestedRuntimeSources(): SpikeCodexRuntimeSource[] {
  return process.argv.includes('--runtime')
    ? [codexRuntimeSourceFromArgs()]
    : ['pinned', 'system'];
}

async function directProtocolProbe(command: string): Promise<{
  startupMs: number;
  serverName: string;
  tools: string[];
  structuredFailure: boolean;
}> {
  const child = spawn(command, ['--business-mcp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const output = createInterface({ input: child.stdout });
  const pending = new Map<number, {
    resolve(value: Record<string, unknown>): void;
    reject(error: Error): void;
  }>();
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  output.on('line', (line) => {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = typeof value.id === 'number' ? value.id : undefined;
    if (id === undefined) return;
    pending.get(id)?.resolve(value);
    pending.delete(id);
  });
  child.once('error', (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  child.once('exit', (code) => {
    if (code === null || code === 0) return;
    const error = new Error(stderr.trim() || `business MCP 退出码 ${code}`);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });

  let nextId = 0;
  const request = async (
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const id = ++nextId;
    const response = new Promise<Record<string, unknown>>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectRequest(new Error(`${method} 超时`));
      }, 5_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveRequest(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectRequest(error);
        },
      });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return response;
  };

  try {
    const started = performance.now();
    const initialized = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'rocketx-spike', version: '1.0.0' },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const listed = await request('tools/list');
    const startupMs = Math.round(performance.now() - started);
    const unknown = await request('tools/call', {
      name: 'missing',
      arguments: {},
    });
    const initializeResult = initialized.result as Record<string, unknown>;
    const listResult = listed.result as { tools?: Array<Record<string, unknown>> };
    const unknownResult = unknown.result as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
    return {
      startupMs,
      serverName: String(
        (initializeResult.serverInfo as Record<string, unknown> | undefined)?.name ?? '',
      ),
      tools: (listResult.tools ?? [])
        .map((tool) => String(tool.name ?? ''))
        .filter(Boolean)
        .sort(),
      structuredFailure:
        unknownResult.isError === true
        && unknownResult.structuredContent?.reason === 'invalid_argument'
        && unknownResult.structuredContent?.retryable === false,
    };
  } finally {
    output.close();
    child.stdin.end();
    child.kill();
  }
}

async function codexProbe(
  source: SpikeCodexRuntimeSource,
  command: string,
  workspace: string,
): Promise<Record<string, unknown>> {
  const invocation = codexInvocation(source);
  const client = new AppServerClient(new NodeCodexTransport(workspace, invocation));
  try {
    await client.start();
    const thread = await client.request('thread/start', {
      cwd: workspace,
      runtimeWorkspaceRoots: [workspace],
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'read-only',
      ephemeral: true,
      config: {
        mcp_servers: {
          [SERVER_NAME]: {
            command,
            args: ['--business-mcp'],
          },
        },
      },
    });
    const status = await client.request('mcpServerStatus/list', {
      threadId: thread.thread.id,
    }, 30_000);
    const server = status.data.find((item) => item.name === SERVER_NAME);
    const tools = Object.keys(server?.tools ?? {}).sort();
    const checks = {
      serverDiscovered: server?.serverInfo?.name === 'rocketx-business',
      toolsDiscovered:
        JSON.stringify(tools) === JSON.stringify(EXPECTED_TOOLS),
    };
    return {
      runtimeSource: source,
      runtimePath: invocation.displayPath,
      cliVersion: invocation.version,
      result: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
      checks,
      tools,
    };
  } catch (error) {
    return {
      runtimeSource: source,
      runtimePath: invocation.displayPath,
      cliVersion: invocation.version,
      result: 'FAIL',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await client.stop().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const command = binaryPath();
  const root = await mkdtemp(join(tmpdir(), 'rocketx-business-mcp-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  try {
    const direct = await directProtocolProbe(command);
    const runtimes = [];
    for (const source of requestedRuntimeSources()) {
      runtimes.push(await codexProbe(source, command, workspace));
    }
    const directChecks = {
      fixedToolList:
        JSON.stringify(direct.tools) === JSON.stringify(EXPECTED_TOOLS),
      noConfigStartupUnderOneSecond: direct.startupMs < 1_000,
      structuredUnknownToolFailure: direct.structuredFailure,
    };
    const passed =
      direct.serverName === 'rocketx-business'
      && Object.values(directChecks).every(Boolean)
      && runtimes.every((runtime) => runtime.result === 'PASS');
    console.log(JSON.stringify({
      spike: 'business-mcp-runtime',
      result: passed ? 'PASS' : 'FAIL',
      command,
      direct: { ...direct, checks: directChecks },
      runtimes,
    }, null, 2));
    process.exitCode = passed ? 0 : 1;
  } finally {
    await removeSpikeTempRoot(root, 'rocketx-business-mcp-');
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
