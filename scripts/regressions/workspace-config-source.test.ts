import assert from 'node:assert/strict';
import test from 'node:test';
import { AdoRequestTimeoutError } from '../../apps/web/src/lib/adoDirect';
import {
  fetchWorkspaceConfig,
  fetchWorkspaceConfigFromSource,
  parseWorkspaceConfigRemoteInput,
  rebindAdoWorkspaceSource,
} from '../../apps/web/src/lib/workspaceConfigSource';
import {
  shouldCheckWorkspaceSync,
  workspaceSourceSnapshotKey,
} from '../../apps/web/src/lib/workspaceConfig';

test('团队配置 URL 每次先授权 origin 再发起请求', async () => {
  const calls: string[] = [];
  const config = await fetchWorkspaceConfig(' https://git.example.com/raw/rcx.workspace.json ', {
    ensureOrigin: async (url) => {
      calls.push(`allow:${url}`);
      return new URL(url.toString()).origin;
    },
    fetch: (async (url: RequestInfo | URL) => {
      calls.push(`fetch:${url.toString()}`);
      return new Response(JSON.stringify({
        version: 1,
        rocketChat: { url: 'https://chat.example.com' },
      }));
    }) as typeof fetch,
  });
  assert.deepEqual(calls, [
    'allow:https://git.example.com/raw/rcx.workspace.json',
    'fetch:https://git.example.com/raw/rcx.workspace.json',
  ]);
  assert.equal(config.rocketChat?.url, 'https://chat.example.com');
});

test('团队配置 HTTP 失败保留明确状态码', async () => {
  await assert.rejects(
    fetchWorkspaceConfig('https://git.example.com/raw/rcx.workspace.json', {
      ensureOrigin: async () => 'https://git.example.com',
      fetch: (async () => new Response('', { status: 503 })) as typeof fetch,
    }),
    /HTTP 503/,
  );
});

test('ADO 来源读取复用当前工作台 base/auth，并把当前连接写回来源 identity', async () => {
  let capturedConfig: unknown;
  let capturedSource: unknown;
  const result = await fetchWorkspaceConfigFromSource(
    {
      kind: 'ado',
      ado: {
        adoBase: 'https://ado.old/tfs/Legacy',
        auth: 'pat',
        project: 'Road Map',
        repository: 'Rocket X',
        ref: 'refs/heads/main',
        path: '/config/rcx.workspace.json',
      },
    },
    {
      ensureOrigin: async () => 'https://git.example.com',
      fetch: (async () => new Response('unused')) as typeof fetch,
      loadWorkbench: () => ({
        adoBase: 'https://ado.current/tfs/DefaultCollection/',
        pat: 'secret-token',
        auth: 'bearer',
        account: 'alice',
      }),
      readAdoFile: async (cfg, source) => {
        capturedConfig = cfg;
        capturedSource = source;
        return JSON.stringify({
          version: 1,
          rocketChat: { url: 'https://chat.example.com' },
        });
      },
    },
  );

  assert.equal(result.config.rocketChat?.url, 'https://chat.example.com');
  assert.deepEqual(capturedConfig, {
    adoBase: 'https://ado.current/tfs/DefaultCollection',
    pat: 'secret-token',
    auth: 'bearer',
  });
  assert.deepEqual(capturedSource, {
    adoBase: 'https://ado.current/tfs/DefaultCollection',
    auth: 'bearer',
    project: 'Road Map',
    repository: 'Rocket X',
    ref: 'refs/heads/main',
    path: '/config/rcx.workspace.json',
  });
  assert.equal(result.source.kind, 'ado');
  assert.deepEqual(result.source.ado, capturedSource);
});

test('统一来源输入会识别 UNC、ADO 仓库文件链接和普通 URL', () => {
  assert.deepEqual(
    parseWorkspaceConfigRemoteInput('\\\\server\\share\\team\\rcx.workspace.json'),
    { kind: 'unc', path: '\\\\server\\share\\team\\rcx.workspace.json' },
  );
  assert.deepEqual(
    parseWorkspaceConfigRemoteInput(
      'https://ado.example.com/tfs/DefaultCollection/Road%20Map/_git/Rocket%20X?path=%2Fconfig%2Frcx.workspace.json&version=GBmain&_a=contents',
      { adoBase: 'https://ado.example.com/tfs/DefaultCollection', pat: '', auth: 'ntlm', account: 'alice' },
    ),
    {
      kind: 'ado',
      ado: {
        project: 'Road Map',
        repository: 'Rocket X',
        ref: 'refs/heads/main',
        path: '/config/rcx.workspace.json',
      },
    },
  );
  assert.deepEqual(
    parseWorkspaceConfigRemoteInput(
      'https://git.example.com/raw/rcx.workspace.json',
      { adoBase: 'https://ado.example.com/tfs/DefaultCollection', pat: '', auth: 'pat', account: 'alice' },
    ),
    { kind: 'url', url: 'https://git.example.com/raw/rcx.workspace.json' },
  );
});

test('UNC 来源拒绝 NT 设备路径、点段和混合分隔符', () => {
  for (const target of [
    '\\\\.\\D:\\team\\rcx.workspace.json',
    '\\\\?\\UNC\\server\\share\\rcx.workspace.json',
    '\\\\server\\share\\..\\rcx.workspace.json',
    '\\\\server/share/rcx.workspace.json',
  ]) {
    assert.throws(() => parseWorkspaceConfigRemoteInput(target), /UNC|反斜杠|设备路径|路径段/);
  }
});

test('ADO 仓库文件链接要求与当前工作台连接兼容，并支持 Items API ref 规范化', () => {
  assert.throws(
    () => parseWorkspaceConfigRemoteInput(
      'https://ado.other.com/tfs/Other/Road%20Map/_git/Rocket%20X?path=%2Fconfig%2Frcx.workspace.json&version=GBmain',
      { adoBase: 'https://ado.example.com/tfs/DefaultCollection', pat: '', auth: 'pat', account: 'alice' },
    ),
    /当前工作台连接/,
  );
  assert.deepEqual(
    parseWorkspaceConfigRemoteInput(
      'https://ado.example.com/tfs/DefaultCollection/Road%20Map/_apis/git/repositories/Rocket%20X/items?path=%2Fconfig%2Frcx.workspace.json&versionDescriptor.version=release%2F2026.08&versionDescriptor.versionType=branch',
      { adoBase: 'https://ado.example.com/tfs/DefaultCollection', pat: '', auth: 'pat', account: 'alice' },
    ),
    {
      kind: 'ado',
      ado: {
        project: 'Road Map',
        repository: 'Rocket X',
        ref: 'refs/heads/release/2026.08',
        path: '/config/rcx.workspace.json',
      },
    },
  );
});

test('ADO 连接变化会替换旧身份并立即重置每日检查节流', () => {
  const rebound = rebindAdoWorkspaceSource(
    {
      kind: 'ado',
      importedAt: 10,
      applied: {},
      follow: true,
      lastCheckedAt: 99,
      ado: {
        adoBase: 'https://ado.old/tfs/Legacy',
        auth: 'ntlm',
        project: 'Road Map',
        repository: 'Rocket X',
        ref: 'refs/heads/main',
        path: '/config/rcx.workspace.json',
      },
    },
    {
      adoBase: 'https://ado.current/tfs/DefaultCollection/',
      pat: 'local-secret',
      account: 'alice',
    },
  );

  assert.equal(rebound.ado.adoBase, 'https://ado.current/tfs/DefaultCollection');
  assert.equal(rebound.ado.auth, 'pat');
  assert.equal(rebound.lastCheckedAt, undefined);
  assert.equal(shouldCheckWorkspaceSync(rebound, 24 * 60 * 60 * 1000), true);
  assert.equal(JSON.stringify(rebound).includes('local-secret'), false);
});

test('UNC 来源读取走独立运行时并保留清晰错误', async () => {
  let capturedPath = '';
  const result = await fetchWorkspaceConfigFromSource(
    { kind: 'unc', path: '\\\\server\\share\\team\\rcx.workspace.json' },
    {
      ensureOrigin: async () => 'https://unused.example.com',
      fetch: (async () => new Response('unused')) as typeof fetch,
      loadWorkbench: () => null,
      readAdoFile: async () => 'unused',
      readUncFile: async (path) => {
        capturedPath = path;
        return JSON.stringify({ version: 1, rocketChat: { url: 'https://chat.example.com' } });
      },
    },
  );
  assert.equal(capturedPath, '\\\\server\\share\\team\\rcx.workspace.json');
  assert.equal(result.source.kind, 'unc');
  assert.equal(result.config.rocketChat?.url, 'https://chat.example.com');

  await assert.rejects(
    fetchWorkspaceConfigFromSource(
      { kind: 'unc', path: 'D:\\temp\\rcx.workspace.json' },
      {
        ensureOrigin: async () => 'https://unused.example.com',
        fetch: (async () => new Response('unused')) as typeof fetch,
        loadWorkbench: () => null,
        readAdoFile: async () => 'unused',
        readUncFile: async () => 'unused',
      },
    ),
    /UNC/,
  );
});

test('来源快照同时区分完整身份和本次导入，旧请求不能命中新来源', () => {
  const first = {
    kind: 'url' as const,
    url: 'https://git.example.com/team-a/workspace.json',
    importedAt: 1,
    applied: {},
  };
  assert.notEqual(
    workspaceSourceSnapshotKey(first),
    workspaceSourceSnapshotKey({ ...first, url: 'https://git.example.com/team-b/workspace.json' }),
  );
  assert.notEqual(
    workspaceSourceSnapshotKey(first),
    workspaceSourceSnapshotKey({ ...first, importedAt: 2 }),
  );
});

test('ADO 来源缺少当前连接时给出明确错误', async () => {
  await assert.rejects(
    fetchWorkspaceConfigFromSource(
      {
        kind: 'ado',
        ado: {
          project: 'Road Map',
          repository: 'Rocket X',
          ref: 'refs/heads/main',
          path: '/config/rcx.workspace.json',
        },
      },
      {
        ensureOrigin: async () => 'https://git.example.com',
        fetch: (async () => new Response('unused')) as typeof fetch,
        loadWorkbench: () => null,
        readAdoFile: async () => JSON.stringify({ version: 1, rocketChat: { url: 'https://chat.example.com' } }),
      },
    ),
    /请先在“工作台”里配置当前 Azure DevOps 连接/,
  );
});

test('ADO 仓库文件解析失败会带上来源前缀', async () => {
  await assert.rejects(
    fetchWorkspaceConfigFromSource(
      {
        kind: 'ado',
        ado: {
          project: 'Road Map',
          repository: 'Rocket X',
          ref: 'refs/heads/main',
          path: '/config/rcx.workspace.json',
        },
      },
      {
        ensureOrigin: async () => 'https://git.example.com',
        fetch: (async () => new Response('unused')) as typeof fetch,
        loadWorkbench: () => ({
          adoBase: 'https://ado.current/tfs/DefaultCollection',
          pat: '',
          auth: 'none',
          account: '',
        }),
        readAdoFile: async () => '{"version":2}',
      },
    ),
    /ADO 仓库文件不是合法的工作区配置：.*版本/,
  );
});

test('ADO 仓库文件超时会转换成不泄露地址的错误', async () => {
  await assert.rejects(
    fetchWorkspaceConfigFromSource(
      {
        kind: 'ado',
        ado: {
          project: 'Road Map',
          repository: 'Rocket X',
          ref: 'refs/heads/main',
          path: '/config/rcx.workspace.json',
        },
      },
      {
        ensureOrigin: async () => 'https://git.example.com',
        fetch: (async () => new Response('unused')) as typeof fetch,
        loadWorkbench: () => ({
          adoBase: 'https://ado.current/tfs/DefaultCollection',
          pat: 'secret-token',
          auth: 'pat',
          account: 'alice',
        }),
        readAdoFile: async () => {
          throw new AdoRequestTimeoutError('GET', 'https://ado.current/private/path', 15_000);
        },
      },
    ),
    (error: unknown) => {
      assert.match(String(error), /读取 ADO 团队配置超时（15 秒）/);
      assert.doesNotMatch(String(error), /ado\.current|private\/path/);
      return true;
    },
  );
});
