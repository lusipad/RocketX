import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { AppServerClient } from '../apps/web/src/agent/protocol/client';
import {
  codexInvocation,
  codexRuntimeSourceFromArgs,
  NodeCodexTransport,
  removeSpikeTempRoot,
  type SpikeCodexRuntimeSource,
} from './lib/codex-app-server-spike';

const SERVER_NAME = 'rocketx_probe';
const TOOL_NAME = 'echo';
const MARKER = 'RCX_MCP_PROJECT_CONFIG_OK';
const SECRET_ENV_NAME = 'ROCKETX_MCP_FAKE_SECRET';
const FAKE_SECRET = `not-a-real-secret-${process.pid}-${Date.now()}`;

interface RuntimeResult {
  runtimeSource: SpikeCodexRuntimeSource;
  runtimePath: string;
  cliVersion: string;
  result: 'PASS' | 'FAIL';
  checks: {
    serverDiscovered: boolean;
    toolDiscovered: boolean;
    toolCalled: boolean;
  };
  credentialProbe: {
    secretInjected: boolean;
    persisted: boolean;
    persistedFiles: string[];
    safeToInline: boolean;
  };
  error?: string;
}

function requestedRuntimeSources(): SpikeCodexRuntimeSource[] {
  return process.argv.includes('--runtime')
    ? [codexRuntimeSourceFromArgs()]
    : ['pinned', 'system'];
}

function probeServerSource(): string {
  return [
    "import { createInterface } from 'node:readline';",
    "const input = createInterface({ input: process.stdin });",
    'function send(id, result) {',
    "  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\\n`);",
    '}',
    "input.on('line', (line) => {",
    '  let message;',
    '  try { message = JSON.parse(line); } catch { return; }',
    "  if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;",
    "  if (message.method === 'initialize') {",
    '    send(message.id, {',
    "      protocolVersion: '2025-06-18',",
    "      capabilities: { tools: { listChanged: false } },",
    "      serverInfo: { name: 'rocketx-probe', version: '1.0.0' },",
    '    });',
    '    return;',
    '  }',
    "  if (message.method === 'ping') { send(message.id, {}); return; }",
    "  if (message.method === 'tools/list') {",
    '    send(message.id, { tools: [{',
    `      name: '${TOOL_NAME}',`,
    "      description: 'Echo a value through the RocketX MCP contract probe.',",
    '      inputSchema: {',
    "        type: 'object',",
    "        properties: { value: { type: 'string' } },",
    "        required: ['value'],",
    '        additionalProperties: false,',
    '      },',
    '      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },',
    '    }] });',
    '    return;',
    '  }',
    "  if (message.method === 'tools/call' && message.params?.name === 'echo') {",
    '    const value = String(message.params?.arguments?.value ?? "");',
    `    const secretInjected = typeof process.env.${SECRET_ENV_NAME} === 'string'`,
    `      && process.env.${SECRET_ENV_NAME}.length > 0;`,
    '    send(message.id, {',
    `      content: [{ type: 'text', text: '${MARKER}:' + value }],`,
    `      structuredContent: { marker: '${MARKER}', value, secretInjected },`,
    '      isError: false,',
    '    });',
    '    return;',
    '  }',
    '  process.stdout.write(`${JSON.stringify({',
    "    jsonrpc: '2.0',",
    '    id: message.id,',
    "    error: { code: -32601, message: 'Method not found' },",
    '  })}\\n`);',
    '});',
    '',
  ].join('\n');
}

async function filesContaining(root: string, needle: string): Promise<string[]> {
  const matches: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const contents = await readFile(path).catch(() => undefined);
        if (contents?.includes(Buffer.from(needle))) matches.push(relative(root, path));
      }
    }
  };
  await visit(root);
  return matches.sort();
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function textContent(content: readonly unknown[]): string {
  return content
    .filter((item): item is { type: string; text: string } =>
      typeof item === 'object'
      && item !== null
      && (item as { type?: unknown }).type === 'text'
      && typeof (item as { text?: unknown }).text === 'string')
    .map((item) => item.text)
    .join('\n');
}

async function runRuntime(source: SpikeCodexRuntimeSource): Promise<RuntimeResult> {
  const invocation = codexInvocation(source);
  const root = await mkdtemp(join(tmpdir(), 'rocketx-mcp-config-'));
  const workspace = join(root, 'workspace');
  const codexHome = join(root, 'codex-home');
  const serverPath = join(root, 'rocketx-mcp-probe.mjs');
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(codexHome, { recursive: true }),
    writeFile(serverPath, probeServerSource()),
  ]);
  const client = new AppServerClient(
    new NodeCodexTransport(workspace, invocation, { codexHome }),
  );
  let result: RuntimeResult | undefined;
  let secretInjected = false;
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
            command: process.execPath,
            args: [serverPath],
            env: {
              [SECRET_ENV_NAME]: FAKE_SECRET,
            },
          },
        },
      },
    });
    const status = await client.request('mcpServerStatus/list', {
      threadId: thread.thread.id,
    }, 30_000);
    const server = status.data.find((item) => item.name === SERVER_NAME);
    const call = await client.request('mcpServer/tool/call', {
      threadId: thread.thread.id,
      server: SERVER_NAME,
      tool: TOOL_NAME,
      arguments: { value: 'project-config' },
    }, 30_000);
    const checks = {
      serverDiscovered: server?.serverInfo?.name === 'rocketx-probe',
      toolDiscovered: Boolean(server?.tools[TOOL_NAME]),
      toolCalled:
        call.isError !== true
        && textContent(call.content).includes(`${MARKER}:project-config`),
    };
    secretInjected = record(call.structuredContent)?.secretInjected === true;
    result = {
      runtimeSource: source,
      runtimePath: invocation.displayPath,
      cliVersion: invocation.version,
      result: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
      checks,
      credentialProbe: {
        secretInjected,
        persisted: false,
        persistedFiles: [],
        safeToInline: false,
      },
    };
  } catch (error) {
    result = {
      runtimeSource: source,
      runtimePath: invocation.displayPath,
      cliVersion: invocation.version,
      result: 'FAIL',
      checks: {
        serverDiscovered: false,
        toolDiscovered: false,
        toolCalled: false,
      },
      credentialProbe: {
        secretInjected,
        persisted: false,
        persistedFiles: [],
        safeToInline: false,
      },
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await client.stop().catch(() => undefined);
    const persistedFiles = await filesContaining(codexHome, FAKE_SECRET);
    result ??= {
      runtimeSource: source,
      runtimePath: invocation.displayPath,
      cliVersion: invocation.version,
      result: 'FAIL',
      checks: {
        serverDiscovered: false,
        toolDiscovered: false,
        toolCalled: false,
      },
      credentialProbe: {
        secretInjected,
        persisted: false,
        persistedFiles: [],
        safeToInline: false,
      },
      error: 'MCP probe ended without a result.',
    };
    result.credentialProbe = {
      secretInjected,
      persisted: persistedFiles.length > 0,
      persistedFiles,
      safeToInline: secretInjected && persistedFiles.length === 0,
    };
    await removeSpikeTempRoot(root, 'rocketx-mcp-config-');
  }
  return result;
}

async function main(): Promise<void> {
  const runtimes: RuntimeResult[] = [];
  for (const source of requestedRuntimeSources()) {
    runtimes.push(await runRuntime(source));
  }
  const passed = runtimes.every((runtime) => runtime.result === 'PASS');
  console.log(JSON.stringify({
    spike: 'codex-mcp-project-config',
    result: passed ? 'PASS' : 'FAIL',
    runtimes,
  }, null, 2));
  process.exitCode = passed ? 0 : 1;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
