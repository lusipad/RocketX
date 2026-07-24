import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  setButlerBrainStorage,
  setButlerBrainTauriProvider,
  setCodexBrainUnavailableReason,
} from '../apps/web/src/lib/butlerBrain';
import { writeButlerWorkspaceFiles } from '../apps/web/src/lib/butlerArchive';
import {
  BUILT_IN_BUTLER_SKILLS,
  DEFAULT_PERSONA,
} from '../apps/web/src/lib/butlerProfile';
import {
  setButlerAzureDevOpsServerReadInvoker,
  type ButlerAzureDevOpsServerReadRequest,
} from '../apps/web/src/lib/butlerTools';
import {
  runButlerCodexEphemeral,
  setButlerCodexTransportFactory,
  setButlerCodexWorkspaceResolver,
} from '../apps/web/src/stores/butlerCodex';
import { useWorkbench } from '../apps/web/src/stores/workbench';
import {
  codexInvocation,
  NodeCodexTransport,
  turnInputs,
} from './lib/codex-app-server-spike';

const SKILL_NAME = 'azure-devops-server';
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

async function runHostAdapter(
  adapterPath: string,
  request: ButlerAzureDevOpsServerReadRequest,
): Promise<unknown> {
  const child = spawn(
    'pwsh',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', adapterPath],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify(request));
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
  });
  if (code !== 0) throw new Error(stderr.trim() || `host adapter 退出码 ${code}`);
  return JSON.parse(stdout.trim().replace(/^\uFEFF/, ''));
}

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'rocketx-butler-azure-skill-'));
  const bundledRoot = resolve('apps/desktop/src-tauri/resources/codex-skills');
  const adapterPath = join(bundledRoot, 'azure-devops-server-host-adapter.ps1');
  const invocation = codexInvocation();
  const transports: NodeCodexTransport[] = [];
  const toolRequests: ButlerAzureDevOpsServerReadRequest[] = [];
  const mockRequests: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const previousConfig = useWorkbench.getState().config;
  let server: Server | undefined;
  const restoreStorage = setButlerBrainStorage(new MemoryStorage());
  const restorePlatform = setButlerBrainTauriProvider(() => true);
  const restoreWorkspace = setButlerCodexWorkspaceResolver(async () => workspaceRoot);
  const restoreTransport = setButlerCodexTransportFactory((_sessionId, root) => {
    const transport = new NodeCodexTransport(root, invocation);
    transports.push(transport);
    return transport;
  });
  const restoreAzureInvoker = setButlerAzureDevOpsServerReadInvoker(async (request) => {
    toolRequests.push(structuredClone(request));
    return runHostAdapter(adapterPath, request);
  });
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
    useWorkbench.setState({
      config: {
        adoBase: mock.collectionUrl,
        auth: 'ntlm',
        account: 'e2e',
      },
    });

    const abort = new AbortController();
    const timeout = setTimeout(
      () => abort.abort(new Error(`Azure Skill CLI spike 超时（${timeoutMs}ms）`)),
      timeoutMs,
    );
    let answer: { text: string };
    try {
      answer = await runButlerCodexEphemeral({
        text: [
          '只读取 Azure DevOps Server PR #42 的元数据，不比较、不读取 iteration 或文件。',
          '必须按当前 Skill 把查询转换为 run_azure_devops_server_cli 调用；不得执行 PowerShell 或 shell。',
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
      controlledToolCalled: toolNames.includes('run_azure_devops_server_cli'),
      oldPrToolsAbsent: !toolNames.some((name) =>
        ['get_pull_request', 'list_pull_request_changes', 'read_pull_request_file'].includes(name ?? ''),
      ),
      hostForcedGet: toolRequests.length > 0 && toolRequests.every((request) => request.method === 'GET'),
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
      coverage: {
        codexSkillToWebTool: true,
        hostAdapterToMockAdo: true,
        tauriInvoke: false,
      },
      checks,
      toolNames,
      toolRequests: toolRequests.map(({ pat: _pat, ...request }) => request),
      mockRequests,
      answer: answer.text,
      stderr: transports.flatMap((transport) => transport.stderr),
    }, null, 2));
    process.exitCode = passed ? 0 : 1;
  } finally {
    useWorkbench.setState({ config: previousConfig });
    restoreAzureInvoker();
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
