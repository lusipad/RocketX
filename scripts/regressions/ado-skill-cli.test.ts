import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createButlerTools,
  setButlerAzureDevOpsServerReadInvoker,
  type ButlerAzureDevOpsServerReadRequest,
} from '../../apps/web/src/lib/butlerTools';
import { useWorkbench } from '../../apps/web/src/stores/workbench';

test.afterEach(() => {
  useWorkbench.setState({ config: null });
});

test('Azure Skill 只暴露一个受控只读 CLI 工具，并由宿主注入连接与凭据', async () => {
  useWorkbench.setState({
    config: {
      adoBase: 'https://ado.example.test/tfs/DefaultCollection',
      pat: 'top-secret',
      auth: 'pat',
      account: 'alice',
    },
  });
  let captured: ButlerAzureDevOpsServerReadRequest | undefined;
  const restore = setButlerAzureDevOpsServerReadInvoker(async (request) => {
    captured = structuredClone(request);
    return { count: 1, value: [{ id: 42, fields: { 'System.Title': '真实结果' } }] };
  });

  try {
    const tools = createButlerTools();
    const azureTools = tools.filter((tool) =>
      tool.name === 'run_azure_devops_server_cli'
      || ['get_pull_request', 'list_pull_request_changes', 'read_pull_request_file'].includes(tool.name),
    );
    assert.deepEqual(azureTools.map((tool) => tool.name), ['run_azure_devops_server_cli']);
    assert.equal(azureTools[0]?.effect, 'read');
    assert.equal(azureTools[0]?.capability, 'ado.server.read');

    const result = await azureTools[0]!.invoke({
      area: 'wit',
      resource: 'workitems',
      project: 'Rocket X',
      query: { ids: [42], '$expand': 'relations' },
    });

    assert.equal(result.status, 'completed');
    assert.deepEqual(JSON.parse(result.content ?? ''), {
      count: 1,
      value: [{ id: 42, fields: { 'System.Title': '真实结果' } }],
    });
    assert.deepEqual(captured, {
      method: 'GET',
      collectionUrl: 'https://ado.example.test/tfs/DefaultCollection',
      authMode: 'pat',
      pat: 'top-secret',
      area: 'wit',
      resource: 'workitems',
      project: 'Rocket X',
      query: { ids: [42], '$expand': 'relations' },
    });

    const rejected = await azureTools[0]!.invoke({
      resource: 'projects',
      method: 'DELETE',
      collectionUrl: 'https://attacker.invalid/',
      pat: 'attacker-controlled',
    });
    assert.equal(rejected.status, 'failed');
    assert.match(rejected.error?.message ?? '', /method 不是允许的字段/);
  } finally {
    restore();
  }
});

test('CLI 工具拒绝 Azure Skill 不支持的 bearer/匿名认证', async () => {
  const tool = createButlerTools().find((candidate) => candidate.name === 'run_azure_devops_server_cli')!;
  for (const auth of ['bearer', 'none'] as const) {
    useWorkbench.setState({
      config: {
        adoBase: 'https://ado.example.test/tfs/DefaultCollection',
        pat: auth === 'bearer' ? 'token' : '',
        auth,
        account: 'alice',
      },
    });
    const result = await tool.invoke({ resource: 'projects' });
    assert.equal(result.status, 'failed');
    assert.match(result.error?.message ?? '', /只支持 PAT 或 Windows 集成认证/);
  }
});

test('CLI 工具默认通过已注册的 Tauri 命令传递受控请求', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let captured:
    | { command: string; args: Record<string, unknown> }
    | undefined;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, unknown>) => {
          captured = structuredClone({ command, args });
          return { value: [{ pullRequestId: 42 }] };
        },
      },
    },
  });
  useWorkbench.setState({
    config: {
      adoBase: 'https://ado.example.test/tfs/DefaultCollection',
      auth: 'ntlm',
      account: 'DOMAIN\\alice',
    },
  });

  try {
    const tool = createButlerTools().find((candidate) => candidate.name === 'run_azure_devops_server_cli')!;
    const result = await tool.invoke({
      area: 'git',
      resource: 'pullrequests/42',
      apiVersion: '6.0',
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(captured, {
      command: 'butler_azure_devops_server_read',
      args: {
        request: {
          method: 'GET',
          collectionUrl: 'https://ado.example.test/tfs/DefaultCollection',
          authMode: 'default-credentials',
          area: 'git',
          resource: 'pullrequests/42',
          apiVersion: '6.0',
        },
      },
    });
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
