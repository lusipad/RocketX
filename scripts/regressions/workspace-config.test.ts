import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  adoConnectionChanged,
  loadWorkspaceSource,
  mergeAppliedFields,
  parseWorkspaceConfig,
  pendingWorkspaceFields,
  planWorkspaceFields,
  saveWorkspaceSource,
  shouldCheckWorkspaceSync,
  type WorkspaceSource,
  type WorkspaceSourceAdoIdentity,
  updateSourceFingerprint,
} from '../../apps/web/src/lib/workspaceConfig';

const FULL_CONFIG = JSON.stringify({
  version: 1,
  name: '团队工作区',
  rocketChat: { url: 'https://chat.example.com/' },
  ado: { url: 'http://ado.example.com/tfs/DefaultCollection', mode: 'direct', auth: 'pat' },
  workItemTemplates: { url: 'https://git.example.com/raw/templates.json' },
});

class MemoryStorage {
  private readonly entries = new Map<string, string>();

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
}

function withMockLocalStorage(callback: (storage: MemoryStorage) => void): void {
  const previous = (globalThis as { localStorage?: Storage }).localStorage;
  const storage = new MemoryStorage() as unknown as Storage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
  try {
    callback(storage as unknown as MemoryStorage);
  } finally {
    if (previous === undefined) {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    } else {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: previous,
      });
    }
  }
}

const ADO_SOURCE: WorkspaceSourceAdoIdentity = {
  adoBase: 'https://ado.example.com',
  auth: 'bearer',
  project: 'RocketX',
  repository: 'desktop',
  ref: 'refs/heads/main',
  path: '/config/rcx.workspace.json',
  name: '团队配置',
};

test('解析配置：URL 规范化去尾斜杠，枚举和版本严格校验（issue #67）', () => {
  const config = parseWorkspaceConfig(FULL_CONFIG);
  assert.equal(config.rocketChat?.url, 'https://chat.example.com');
  assert.equal('mode' in (config.ado ?? {}), false);
  assert.equal('ai' in config, false);

  assert.throws(() => parseWorkspaceConfig('not json'), /JSON/);
  assert.throws(() => parseWorkspaceConfig('{"version":2}'), /版本/);
  assert.throws(
    () => parseWorkspaceConfig('{"version":1,"ado":{"mode":"bridge"}}'),
    /bridge.*移除|直连/,
  );
  assert.throws(
    () => parseWorkspaceConfig('{"version":1,"ado":{"mode":"magic"}}'),
    /只兼容旧版 direct/,
  );
  assert.throws(
    () => parseWorkspaceConfig('{"version":1,"rocketChat":{"url":"ftp://x"}}'),
    /http\/https/,
  );
});

test('工作项模板可内联进工作区配置，且与远程 URL 格式互斥（issue #154）', () => {
  const inline = {
    defaultProject: 'Alpha',
    templates: [
      {
        name: '缺陷修复套装',
        items: [
          { type: 'Bug', title: '{title}' },
          { type: 'Task', title: '【修复】{title}', parent: 0 },
        ],
      },
    ],
  };
  const parsed = parseWorkspaceConfig(JSON.stringify({
    version: 1,
    workItemTemplates: inline,
  }));
  assert.deepEqual(parsed.workItemTemplates, inline);

  assert.throws(
    () => parseWorkspaceConfig(JSON.stringify({
      version: 1,
      workItemTemplates: { url: 'https://git.example.com/templates.json', ...inline },
    })),
    /url.*templates|templates.*url/,
  );
  assert.throws(
    () => parseWorkspaceConfig(JSON.stringify({
      version: 1,
      workItemTemplates: { defaultProject: 'Alpha', templates: [] },
    })),
    /模板列表为空/,
  );
});

test('配置文件是不可信输入：内嵌凭据和已移除 AI 配置都拒绝', () => {
  assert.throws(
    () => parseWorkspaceConfig('{"version":1,"rocketChat":{"url":"https://user:pw@chat.example.com"}}'),
    /凭据不进配置文件/,
  );
  assert.throws(
    () =>
      parseWorkspaceConfig(
        JSON.stringify({
          version: 1,
          ai: {
            providers: [
              { id: 'x', kind: 'openai-compatible', baseUrl: 'https://a.com', model: 'm', key: 'sk-123' },
            ],
          },
        }),
      ),
    /统一使用 Codex/,
  );
});

test('字段计划：本地空值默认应用，用户改过的字段默认保留（issue #67 核心语义）', () => {
  const config = parseWorkspaceConfig(FULL_CONFIG);
  const fields = planWorkspaceFields(
    config,
    {
      // 从没配过：默认勾选写入
      serverUrl: '',
      // 用户自己配过别的地址，且不是从配置应用的：默认保留本地
      adoBase: 'http://my-own-ado/tfs/Other',
      adoAuth: '',
      adoWebUrl: '',
      templatesUrl: '',
    },
    {},
  );
  const byKey = new Map(fields.map((field) => [field.key, field]));

  assert.deepEqual(
    { selected: byKey.get('server.url')?.selected, overridden: byKey.get('server.url')?.overridden },
    { selected: true, overridden: false },
  );
  assert.deepEqual(
    { selected: byKey.get('ado.base')?.selected, overridden: byKey.get('ado.base')?.overridden },
    { selected: false, overridden: true },
  );
  assert.equal(byKey.has('ado.mode'), false);
});

test('内联工作项模板参与配置变更计划（issue #154）', () => {
  const config = parseWorkspaceConfig(JSON.stringify({
    version: 1,
    workItemTemplates: {
      defaultProject: 'Alpha',
      templates: [{ name: '单个工作项', items: [{ type: '{type}', title: '{title}' }] }],
    },
  }));
  const [field] = planWorkspaceFields(config, {}, {});
  assert.equal(field.key, 'templates.inline');
  assert.equal(field.label, '内联工作项模板');
  assert.equal(field.selected, true);
});

test('字段计划：上次从配置应用的值再次同步时跟随新配置，用户后改的保留', () => {
  const config = parseWorkspaceConfig(FULL_CONFIG);
  const lastApplied = {
    'server.url': 'https://old-chat.example.com',
    'ado.base': 'http://ado.example.com/tfs/DefaultCollection',
  };
  const fields = planWorkspaceFields(
    config,
    {
      // 本地值 = 上次应用值 → 是配置管理的，跟随新配置更新
      serverUrl: 'https://old-chat.example.com',
      // 本地值 ≠ 上次应用值 → 用户后来自己改过，保留
      adoBase: 'http://my-own-ado/tfs/Other',
    },
    lastApplied,
  );
  const byKey = new Map(fields.map((field) => [field.key, field]));

  assert.equal(byKey.get('server.url')?.selected, true);
  assert.equal(byKey.get('server.url')?.overridden, false);
  assert.equal(byKey.get('ado.base')?.selected, false);
  assert.equal(byKey.get('ado.base')?.overridden, true);
});

test('ADO webUrl 缺省时回退 ado.url', () => {
  const config = parseWorkspaceConfig(FULL_CONFIG);
  const fields = planWorkspaceFields(config, {}, {});
  const byKey = new Map(fields.map((field) => [field.key, field]));

  assert.equal(byKey.get('ado.webUrl')?.incoming, 'http://ado.example.com/tfs/DefaultCollection');
});

test('新字段解析:更新源三模式与层级形态,非法值整体拒绝', () => {
  const parsed = parseWorkspaceConfig(JSON.stringify({
    version: 1,
    update: { source: 'dir', location: '\\\\server\\share\\rocketx' },
    workItems: { hierarchyLayout: 'story-single' },
  }));
  assert.deepEqual(parsed.update, { source: 'dir', location: '\\\\server\\share\\rocketx' });
  assert.equal(parsed.workItems?.hierarchyLayout, 'story-single');

  // github 不需要 location;http 必须是合法 URL;dir 必须非空
  assert.deepEqual(
    parseWorkspaceConfig(JSON.stringify({ version: 1, update: { source: 'github' } })).update,
    { source: 'github' },
  );
  assert.throws(
    () => parseWorkspaceConfig(JSON.stringify({ version: 1, update: { source: 'http', location: 'not a url' } })),
    /update\.location/,
  );
  assert.throws(
    () => parseWorkspaceConfig(JSON.stringify({ version: 1, update: { source: 'dir', location: ' ' } })),
    /非空路径/,
  );
  assert.throws(
    () => parseWorkspaceConfig(JSON.stringify({ version: 1, update: { source: 'pip' } })),
    /update\.source/,
  );
  assert.throws(
    () => parseWorkspaceConfig(JSON.stringify({ version: 1, workItems: { hierarchyLayout: 'all' } })),
    /hierarchyLayout/,
  );
});

test('新字段进字段计划:更新源与层级形态参与覆盖判定', () => {
  const config = parseWorkspaceConfig(JSON.stringify({
    version: 1,
    update: { source: 'dir', location: '\\\\srv\\rocketx' },
    workItems: { hierarchyLayout: 'feature-single' },
  }));
  const fields = planWorkspaceFields(
    config,
    {
      updateSource: updateSourceFingerprint({ kind: 'github', location: '' }),
      hierarchyLayout: 'feature-split',
    },
    {},
  );
  const byKey = new Map(fields.map((field) => [field.key, field]));
  // 本地是默认值但没有应用记录 → 视为用户配的,默认保留(提醒但不勾选)
  assert.equal(byKey.get('update.source')?.overridden, true);
  assert.equal(byKey.get('workItems.hierarchyLayout')?.overridden, true);

  // 有应用记录且与本地一致 → 上次就是配置写的,这次默认勾选跟随
  const followed = planWorkspaceFields(
    config,
    {
      updateSource: updateSourceFingerprint({ kind: 'github', location: '' }),
      hierarchyLayout: 'feature-split',
    },
    { 'update.source': 'github|', 'workItems.hierarchyLayout': 'feature-split' },
  );
  const followedByKey = new Map(followed.map((field) => [field.key, field]));
  assert.equal(followedByKey.get('update.source')?.selected, true);
  assert.equal(followedByKey.get('workItems.hierarchyLayout')?.selected, true);
});

test('跟随更新判定:URL 来源默认开、显式关掉不查、24 小时节流', () => {
  const day = 24 * 60 * 60 * 1000;
  const base = { kind: 'file' as const, name: 'x', importedAt: 1, applied: {} };
  assert.equal(shouldCheckWorkspaceSync(null, day), false);
  assert.equal(shouldCheckWorkspaceSync({ ...base }, day), false);
  assert.equal(shouldCheckWorkspaceSync({ ...base, kind: 'url', url: 'https://cfg' }, day), true);
  assert.equal(shouldCheckWorkspaceSync({ ...base, kind: 'url', url: 'https://cfg', follow: false }, day), false);
  assert.equal(
    shouldCheckWorkspaceSync({ ...base, kind: 'url', url: 'https://cfg', lastCheckedAt: day - 1000 }, day),
    false,
  );
  assert.equal(
    shouldCheckWorkspaceSync({ ...base, kind: 'url', url: 'https://cfg', lastCheckedAt: 0 }, day),
    true,
  );
  assert.equal(
    shouldCheckWorkspaceSync({ ...base, kind: 'ado', ado: ADO_SOURCE, follow: true, lastCheckedAt: 0 }, day),
    true,
  );
});

test('值得提醒的变化 = 会被默认勾选的字段', () => {
  const fields = planWorkspaceFields(
    parseWorkspaceConfig(JSON.stringify({ version: 1, rocketChat: { url: 'https://chat.new' } })),
    { serverUrl: 'https://chat.old' },
    { 'server.url': 'https://chat.old' },
  );
  assert.equal(pendingWorkspaceFields(fields).length, 1);

  const noise = planWorkspaceFields(
    parseWorkspaceConfig(JSON.stringify({ version: 1, rocketChat: { url: 'https://chat.old' } })),
    { serverUrl: 'https://chat.old' },
    {},
  );
  assert.equal(pendingWorkspaceFields(noise).length, 0);
});

test('应用记录合并：只记录本次应用的字段，未勾选字段保留旧记录', () => {
  const merged = mergeAppliedFields(
    {
      kind: 'url',
      url: 'https://old',
      name: '旧',
      importedAt: 1,
      applied: { 'server.url': 'a', 'ado.base': 'b' },
    },
    { url: 'https://new', importedAt: 2 },
    { 'server.url': 'a2' },
  );
  assert.deepEqual(merged, {
    kind: 'url',
    url: 'https://new',
    name: '旧',
    importedAt: 2,
    applied: { 'server.url': 'a2', 'ado.base': 'b' },
    follow: true,
  });
});

test('ADO 端点变化会触发 PAT 解绑', () => {
  assert.equal(
    adoConnectionChanged(
      { adoBase: 'https://ado.old', auth: 'pat' },
      { adoBase: 'https://ado.new', auth: 'pat' },
    ),
    true,
  );
  assert.equal(
    adoConnectionChanged(
      { adoBase: 'https://ado.old', auth: 'pat' },
      { adoBase: 'https://ado.old', auth: 'pat' },
    ),
    false,
  );
});

test('同一 URL 重新应用保留跟随偏好和检查时间，本地文件会清除旧 URL', () => {
  const previous: WorkspaceSource = {
    kind: 'url',
    url: 'https://git.example.com/raw/rcx.workspace.json',
    name: '团队',
    importedAt: 1,
    applied: { 'server.url': 'https://chat.example.com' },
    follow: false,
    lastCheckedAt: 123,
  };
  assert.deepEqual(
    mergeAppliedFields(
      previous,
      { url: previous.url, sourceKind: 'url', importedAt: 2 },
      { 'ado.base': 'https://ado.example.com' },
    ),
    {
      ...previous,
      importedAt: 2,
      applied: {
        'server.url': 'https://chat.example.com',
        'ado.base': 'https://ado.example.com',
      },
    },
  );
  assert.deepEqual(
    mergeAppliedFields(previous, { sourceKind: 'file', name: '离线配置', importedAt: 3 }, {}),
    {
      kind: 'file',
      name: '离线配置',
      importedAt: 3,
      applied: previous.applied,
    },
  );
});

test('loadWorkspaceSource 兼容旧版 URL / 文件结构并在读取时清洗脏记录', () => {
  withMockLocalStorage((storage) => {
    storage.setItem('rcx-workspace-source', JSON.stringify({
      url: 'https://alice:pw@git.example.com/raw/rcx.workspace.json/',
      name: ' 团队配置 ',
      importedAt: 12,
      applied: {
        'server.url': 'https://chat.example.com',
        authToken: 'should-not-stay',
      },
      follow: true,
      lastCheckedAt: 24,
      token: 'secret',
      localPath: 'C:\\Users\\alice\\Desktop\\rcx.workspace.json',
    }));
    assert.deepEqual(loadWorkspaceSource(), {
      kind: 'url',
      url: 'https://git.example.com/raw/rcx.workspace.json',
      name: '团队配置',
      importedAt: 12,
      applied: { 'server.url': 'https://chat.example.com' },
      follow: true,
      lastCheckedAt: 24,
    });

    storage.setItem('rcx-workspace-source', JSON.stringify({
      name: '旧版文件导入',
      importedAt: 30,
      applied: { 'server.url': 'https://chat.example.com' },
    }));
    assert.deepEqual(loadWorkspaceSource(), {
      kind: 'file',
      name: '旧版文件导入',
      importedAt: 30,
      applied: { 'server.url': 'https://chat.example.com' },
    });
  });
});

test('saveWorkspaceSource 只按白名单持久化，file 来源不存本机绝对路径', () => {
  withMockLocalStorage((storage) => {
    saveWorkspaceSource({
      kind: 'file',
      name: '本地导入',
      importedAt: 7,
      applied: {
        'server.url': 'https://chat.example.com',
        authToken: 'should-not-stay',
      },
    });
    assert.deepEqual(JSON.parse(storage.getItem('rcx-workspace-source') ?? 'null'), {
      kind: 'file',
      name: '本地导入',
      importedAt: 7,
      applied: { 'server.url': 'https://chat.example.com' },
    });
  });
});

test('ADO 来源会持久化结构化 identity，并在变化时重置节流', () => {
  withMockLocalStorage((storage) => {
    saveWorkspaceSource({
      kind: 'ado',
      name: 'ADO 团队配置',
      importedAt: 8,
      applied: { 'ado.base': 'https://ado.example.com' },
      follow: true,
      lastCheckedAt: 9,
      ado: {
        ...ADO_SOURCE,
        adoBase: 'https://alice:pw@ado.example.com',
        webUrl: 'https://alice:pw@ado.example.com/projects/rocketx',
      },
    });
    assert.deepEqual(JSON.parse(storage.getItem('rcx-workspace-source') ?? 'null'), {
      kind: 'ado',
      name: 'ADO 团队配置',
      importedAt: 8,
      applied: { 'ado.base': 'https://ado.example.com' },
      follow: true,
      lastCheckedAt: 9,
      ado: {
        adoBase: 'https://ado.example.com',
        auth: 'bearer',
        webUrl: 'https://ado.example.com/projects/rocketx',
        project: 'RocketX',
        repository: 'desktop',
        ref: 'refs/heads/main',
        path: '/config/rcx.workspace.json',
        name: '团队配置',
      },
    });
  });

  const previous = mergeAppliedFields(
    null,
    { sourceKind: 'ado', importedAt: 1, ado: ADO_SOURCE, checkedAt: 100 },
    { 'server.url': 'https://chat.example.com' },
  );
  assert.equal(previous.kind, 'ado');
  assert.equal(previous.follow, true);
  assert.equal(previous.lastCheckedAt, 100);

  const sameIdentity = mergeAppliedFields(
    previous,
    { sourceKind: 'ado', importedAt: 2, ado: { ...ADO_SOURCE, name: '团队配置' } },
    { 'ado.base': 'https://ado.example.com' },
  );
  assert.equal(sameIdentity.kind, 'ado');
  assert.equal(sameIdentity.follow, true);
  assert.equal(sameIdentity.lastCheckedAt, 100);

  const movedPath = mergeAppliedFields(
    sameIdentity,
    { sourceKind: 'ado', importedAt: 3, ado: { ...ADO_SOURCE, path: '/config/next.workspace.json' } },
    {},
  );
  assert.equal(movedPath.kind, 'ado');
  assert.equal(movedPath.follow, true);
  assert.equal(movedPath.lastCheckedAt, undefined);
});

test('仓库自带的示例配置永远能过解析器(样例防腐锁)', () => {
  const sample = parseWorkspaceConfig(
    readFileSync('docs/examples/rcx.workspace.sample.json', 'utf8'),
  );
  assert.equal(sample.version, 1);
  assert.ok(sample.rocketChat?.url);
  assert.equal(sample.ado?.auth, 'ntlm');
  assert.equal(sample.update?.source, 'dir');
  assert.equal(sample.workItems?.hierarchyLayout, 'feature-split');
  assert.ok(sample.workItemTemplates && 'templates' in sample.workItemTemplates);
  const templates = sample.workItemTemplates && 'templates' in sample.workItemTemplates
    ? sample.workItemTemplates.templates
    : [];
  assert.ok(templates.length > 0);
  for (const template of templates) {
    assert.ok(typeof template.name === 'string' && template.name.length > 0);
    assert.ok(Array.isArray(template.items) && template.items.length > 0);
  }
});
