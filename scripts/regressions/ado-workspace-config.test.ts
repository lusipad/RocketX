import assert from 'node:assert/strict';
import test from 'node:test';
import { directReadRepositoryFile } from '../../apps/web/src/lib/adoDirect';

function adoJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function withMockFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  callback: () => Promise<void>,
): Promise<void> {
  const previous = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try {
    await callback();
  } finally {
    globalThis.fetch = previous;
  }
}

test('directReadRepositoryFile 先校验项目，再从 Git Items API 读取单个文本文件', async () => {
  const calls: { url: string; headers: Headers }[] = [];
  await withMockFetch(async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: input.toString(), headers });
    if (calls.length === 1) return adoJson({ id: 'project-1', name: 'Road Map' });
    return adoJson({
      path: '/config/rcx.workspace.json',
      isFolder: false,
      content: '{"version":1,"rocketChat":{"url":"https://chat.example.com"}}',
    });
  }, async () => {
    const text = await directReadRepositoryFile(
      { adoBase: 'http://ado/tfs/DefaultCollection/', pat: 'secret', auth: 'bearer' },
      {
        project: 'Road Map',
        repository: 'Rocket X',
        ref: 'refs/heads/main',
        path: '/config/rcx.workspace.json',
      },
    );

    assert.equal(text, '{"version":1,"rocketChat":{"url":"https://chat.example.com"}}');
  });

  assert.equal(calls.length, 2);
  assert.equal(
    calls[0]?.url,
    'http://ado/tfs/DefaultCollection/_apis/projects/Road%20Map?api-version=7.0',
  );
  assert.match(
    calls[1]?.url ?? '',
    /^http:\/\/ado\/tfs\/DefaultCollection\/Road%20Map\/_apis\/git\/repositories\/Rocket%20X\/items\?/,
  );
  assert.match(calls[1]?.url ?? '', /path=%2Fconfig%2Frcx\.workspace\.json/);
  assert.match(calls[1]?.url ?? '', /versionDescriptor\.version=main/);
  assert.match(calls[1]?.url ?? '', /versionDescriptor\.versionType=branch/);
  assert.equal(calls[1]?.headers.get('Authorization'), 'Bearer secret');
});

test('directReadRepositoryFile 在项目不存在时给出明确错误，不继续请求仓库文件', async () => {
  const calls: string[] = [];
  await withMockFetch(async (input) => {
    calls.push(input.toString());
    return adoJson({ message: 'missing project' }, 404);
  }, async () => {
    await assert.rejects(
      directReadRepositoryFile(
        { adoBase: 'http://ado/tfs/DefaultCollection', pat: '', auth: 'none' },
        {
          project: 'Road Map',
          repository: 'Rocket X',
          ref: 'refs/heads/main',
          path: '/config/rcx.workspace.json',
        },
      ),
      /ADO 项目「Road Map」不存在，或当前账号无权访问/,
    );
  });

  assert.deepEqual(calls, [
    'http://ado/tfs/DefaultCollection/_apis/projects/Road%20Map?api-version=7.0',
  ]);
});

test('directReadRepositoryFile 在仓库文件无权访问或缺失时给出明确错误', async () => {
  await withMockFetch(async (_input, init) => {
    const url = _input.toString();
    if (url.includes('/_apis/projects/')) return adoJson({ id: 'project-1', name: 'Road Map' });
    assert.equal(new Headers(init?.headers).get('Authorization'), null);
    return adoJson({ message: 'forbidden' }, 403);
  }, async () => {
    await assert.rejects(
      directReadRepositoryFile(
        { adoBase: 'http://ado/tfs/DefaultCollection', pat: '', auth: 'none' },
        {
          project: 'Road Map',
          repository: 'Rocket X',
          ref: 'refs/heads/release/2026.08',
          path: '/config/rcx.workspace.json',
        },
      ),
      /没有权限读取 ADO 仓库文件.*Road Map.*Rocket X/,
    );
  });
});

test('directReadRepositoryFile 在请求前拒绝空分支和不支持的 refs 类型', async () => {
  let calls = 0;
  await withMockFetch(async () => {
    calls += 1;
    return adoJson({});
  }, async () => {
    for (const ref of ['refs/heads/', 'refs/pull/42/head']) {
      await assert.rejects(
        directReadRepositoryFile(
          { adoBase: 'http://ado/tfs/DefaultCollection', pat: '', auth: 'none' },
          {
            project: 'Road Map',
            repository: 'Rocket X',
            ref,
            path: '/config/rcx.workspace.json',
          },
        ),
        /分支名不能为空|只支持分支、标签或提交 SHA/,
      );
    }
  });
  assert.equal(calls, 0);
});

test('directReadRepositoryFile 的 404 不会误报成只有文件路径不存在', async () => {
  await withMockFetch(async (input) => (
    input.toString().includes('/_apis/projects/')
      ? adoJson({ id: 'project-1', name: 'Road Map' })
      : adoJson({ message: 'not found' }, 404)
  ), async () => {
    await assert.rejects(
      directReadRepositoryFile(
        { adoBase: 'http://ado/tfs/DefaultCollection', pat: '', auth: 'none' },
        {
          project: 'Road Map',
          repository: 'Rocket X',
          ref: 'refs/heads/release/2026.08',
          path: '/config/rcx.workspace.json',
        },
      ),
      /找不到 ADO 仓库、Git 引用或文件.*Road Map\/Rocket X.*release\/2026\.08/,
    );
  });
});
