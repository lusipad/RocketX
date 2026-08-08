import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  setButlerBrainStorage,
  setButlerBrainTauriProvider,
  setCodexBrainUnavailableReason,
} from '../apps/web/src/lib/butlerBrain';
import { setBusinessMcpLaunchConfigProvider } from '../apps/web/src/agent/businessMcp';
import { writeButlerWorkspaceFiles } from '../apps/web/src/lib/butlerArchive';
import {
  BUILT_IN_BUTLER_SKILLS,
  DEFAULT_PERSONA,
} from '../apps/web/src/lib/butlerProfile';
import {
  runButlerCodexEphemeral,
  setButlerCodexTransportFactory,
  setButlerCodexWorkspaceResolver,
} from '../apps/web/src/stores/butlerCodex';
import {
  codexInvocation,
  codexRuntimeSourceFromArgs,
  NodeCodexTransport,
  turnInputs,
} from './lib/codex-app-server-spike';

const SKILL_NAME = 'azure-devops-server';
const TOOL_NAME = 'rocketx_azure_devops_server_read';
const RESULT_MARKER = 'RCX_AZURE_SKILL_ADAPTER_6F31';
const timeoutMs = 180_000;

class MemoryStorage {
  private readonly values = new Map<string, string>();

  get(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.values.set(key, value);
  }
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

async function startMockAdo(requests: string[]): Promise<{ server: Server; collectionUrl: string }> {
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (
      request.method === 'GET'
      && request.url?.startsWith('/DefaultCollection/_apis/git/pullrequests/42?')
    ) {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        pullRequestId: 42,
        title: RESULT_MARKER,
        status: 'active',
        repository: { name: 'RocketX', project: { name: 'RocketX' } },
      }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ message: 'mock route not found' }));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法确定 mock ADO 端口');
  return {
    server,
    collectionUrl: `http://127.0.0.1:${address.port}/DefaultCollection`,
  };
}

function businessMcpProbeSource(): string {
  return [
    "import { spawn } from 'node:child_process';",
    "import { createInterface } from 'node:readline';",
    'const adapterPath = process.argv[2];',
    'const collectionUrl = process.argv[3];',
    "const input = createInterface({ input: process.stdin });",
    'function send(id, result) {',
    "  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\\n`);",
    '}',
    'function runAdapter(args) {',
    '  return new Promise((resolve, reject) => {',
    "    const child = spawn('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', adapterPath],",
    "      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });",
    "    let stdout = '';",
    "    let stderr = '';",
    "    child.stdout.setEncoding('utf8');",
    "    child.stderr.setEncoding('utf8');",
    "    child.stdout.on('data', (chunk) => { stdout += chunk; });",
    "    child.stderr.on('data', (chunk) => { stderr += chunk; });",
    '    const timer = setTimeout(() => { child.kill(); reject(new Error("adapter timeout")); }, 15000);',
    "    child.once('error', (error) => { clearTimeout(timer); reject(error); });",
    "    child.once('close', (code) => {",
    '      clearTimeout(timer);',
    '      if (code !== 0) { reject(new Error(stderr.trim() || `adapter exited ${code}`)); return; }',
    "      try { resolve(JSON.parse(stdout.trim().replace(/^\\uFEFF/, ''))); } catch (error) { reject(error); }",
    '    });',
    '    child.stdin.end(JSON.stringify({',
    "      method: 'GET',",
    '      collectionUrl,',
    "      authMode: 'default-credentials',",
    '      pat: null,',
    '      area: args.area ?? null,',
    '      resource: args.resource,',
    '      project: args.project ?? null,',
    '      team: args.team ?? null,',
    '      query: args.query ?? null,',
    '      apiVersion: args.apiVersion ?? null,',
    '      serverVersionHint: args.serverVersionHint ?? null,',
    '      allowConditionalArea: args.allowConditionalArea === true,',
    '    }));',
    '  });',
    '}',
    "input.on('line', async (line) => {",
    '  let message;',
    '  try { message = JSON.parse(line); } catch { return; }',
    "  if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;",
    "  if (message.method === 'initialize') {",
    '    send(message.id, {',
    "      protocolVersion: '2025-06-18',",
    "      capabilities: { tools: { listChanged: false } },",
    "      serverInfo: { name: 'rocketx-business-probe', version: '1.0.0' },",
    '    });',
    '    return;',
    '  }',
    "  if (message.method === 'ping') { send(message.id, {}); return; }",
    "  if (message.method === 'tools/list') {",
    '    send(message.id, { tools: [{',
    `      name: '${TOOL_NAME}',`,
    "      description: '使用 RocketX 注入的连接执行 Azure DevOps Server 只读 GET。',",
    '      inputSchema: {',
    "        type: 'object',",
    '        properties: {',
    "          area: { type: 'string' },",
    "          resource: { type: 'string' },",
    "          project: { type: 'string' },",
    "          team: { type: 'string' },",
    "          query: { type: 'object' },",
    "          apiVersion: { type: 'string' },",
    "          serverVersionHint: { type: 'string' },",
    "          allowConditionalArea: { type: 'boolean' },",
    '        },',
    "        required: ['resource'],",
    '        additionalProperties: false,',
    '      },',
    '      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },',
    '    }] });',
    '    return;',
    '  }',
    `  if (message.method === 'tools/call' && message.params?.name === '${TOOL_NAME}') {`,
    '    try {',
    '      const value = await runAdapter(message.params?.arguments ?? {});',
    '      send(message.id, {',
    "        content: [{ type: 'text', text: JSON.stringify(value) }],",
    '        structuredContent: value,',
    '        isError: false,',
    '      });',
    '    } catch (error) {',
    '      const failure = { status: "unavailable", reason: "adapter_error", retryable: true, message: String(error) };',
    '      send(message.id, {',
    "        content: [{ type: 'text', text: JSON.stringify(failure) }],",
    '        structuredContent: failure,',
    '        isError: true,',
    '      });',
    '    }',
    '    return;',
    '  }',
    "  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id,",
    "    error: { code: -32601, message: 'Method not found' } })}\\n`);",
    '});',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'rocketx-butler-azure-skill-'));
  const bundledRoot = resolve('apps/desktop/src-tauri/resources/codex-skills');
  const adapterPath = join(bundledRoot, 'azure-devops-server-host-adapter.ps1');
  const mcpServerPath = join(workspaceRoot, 'rocketx-business-mcp-probe.mjs');
  const invocation = codexInvocation(codexRuntimeSourceFromArgs());
  const transports: NodeCodexTransport[] = [];
  const mockRequests: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  let server: Server | undefined;
  const restoreStorage = setButlerBrainStorage(new MemoryStorage());
  const restorePlatform = setButlerBrainTauriProvider(() => true);
  const restoreWorkspace = setButlerCodexWorkspaceResolver(async () => workspaceRoot);
  const restoreTransport = setButlerCodexTransportFactory((_sessionId, root) => {
    const transport = new NodeCodexTransport(root, invocation);
    transports.push(transport);
    return transport;
  });
  let restoreBusinessMcp = () => undefined;
  setCodexBrainUnavailableReason(undefined);

  try {
    await writeButlerWorkspaceFiles(
      workspaceRoot,
      DEFAULT_PERSONA,
      BUILT_IN_BUTLER_SKILLS,
      async (path, options) => mkdir(path, { recursive: options?.recursive }),
      async (path) => readFile(path, 'utf8'),
      async (path, options) => rm(path, { recursive: options?.recursive, force: true }),
      async (path, contents) => writeFile(path, contents),
    );
    await cp(
      join(bundledRoot, SKILL_NAME),
      join(workspaceRoot, '.agents', 'skills', SKILL_NAME),
      { recursive: true },
    );
    const mock = await startMockAdo(mockRequests);
    server = mock.server;
    await writeFile(mcpServerPath, businessMcpProbeSource());
    restoreBusinessMcp = setBusinessMcpLaunchConfigProvider(async () => ({
      command: process.execPath,
      args: [mcpServerPath, adapterPath, mock.collectionUrl],
    }));

    const abort = new AbortController();
    const timeout = setTimeout(
      () => abort.abort(new Error(`Azure Skill business MCP spike 超时（${timeoutMs}ms）`)),
      timeoutMs,
    );
    let answer: { text: string };
    try {
      answer = await runButlerCodexEphemeral({
        text: [
          '只读取 Azure DevOps Server PR #42 的元数据，不比较、不读取 iteration 或文件。',
          `必须按 RocketX 托管边界调用 ${TOOL_NAME}；不得直接执行 PowerShell 或 shell。`,
          `最终回答必须原样包含返回标题中的标记 ${RESULT_MARKER}。`,
        ].join('\n'),
        skillName: SKILL_NAME,
        signal: abort.signal,
        onEvent: (event) => events.push(structuredClone(event) as Record<string, unknown>),
      });
    } finally {
      clearTimeout(timeout);
    }

    const input = turnInputs(transports[0]!);
    const toolNames = events
      .filter((event) => event.type === 'tool-call')
      .map((event) => (event.toolCall as { name?: string } | undefined)?.name);
    const toolResult = events
      .filter((event) => event.type === 'tool-result')
      .map((event) => String(event.content ?? ''))
      .join('\n');
    const checks = {
      nativeSkillInput: input[1]?.type === 'skill' && input[1].name === SKILL_NAME,
      businessMcpToolCalled: toolNames.some((name) => name?.includes(TOOL_NAME)),
      legacyDynamicToolUnused: !toolNames.includes('run_azure_devops_server_cli'),
      oldPrToolsAbsent: !toolNames.some((name) =>
        ['get_pull_request', 'list_pull_request_changes', 'read_pull_request_file'].includes(name ?? ''),
      ),
      mockAdoReached: mockRequests.some((request) =>
        request.startsWith('GET /DefaultCollection/_apis/git/pullrequests/42?'),
      ),
      toolReturnedMarker: toolResult.includes(RESULT_MARKER),
      answerUsedRealResult: answer.text.includes(RESULT_MARKER),
    };
    const passed = Object.values(checks).every(Boolean);
    console.log(JSON.stringify({
      spike: 'butler-azure-skill-adapter-path',
      result: passed ? 'PASS' : 'FAIL',
      cliVersion: invocation.version,
      runtimeSource: invocation.source,
      runtimePath: invocation.displayPath,
      coverage: {
        codexSkillToBusinessMcp: true,
        businessMcpContractToHostAdapter: true,
        hostAdapterToMockAdo: true,
        rustKeychainBridge: false,
        tauriInvoke: false,
      },
      checks,
      toolNames,
      mockRequests,
      answer: answer.text,
      stderr: transports.flatMap((transport) => transport.stderr),
    }, null, 2));
    process.exitCode = passed ? 0 : 1;
  } finally {
    restoreBusinessMcp();
    restoreTransport();
    restoreWorkspace();
    restorePlatform();
    restoreStorage();
    setCodexBrainUnavailableReason(undefined);
    await closeServer(server);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
