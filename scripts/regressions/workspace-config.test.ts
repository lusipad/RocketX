import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aiProviderFingerprint,
  mergeAppliedFields,
  parseWorkspaceConfig,
  planWorkspaceFields,
} from '../../apps/web/src/lib/workspaceConfig';

const FULL_CONFIG = JSON.stringify({
  version: 1,
  name: '团队工作区',
  rocketChat: { url: 'https://chat.example.com/' },
  ado: { url: 'http://ado.example.com/tfs/DefaultCollection', mode: 'direct', auth: 'pat' },
  workItemTemplates: { url: 'https://git.example.com/raw/templates.json' },
  ai: {
    providers: [
      { id: 'deepseek', kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
    ],
  },
});

test('解析配置：URL 规范化去尾斜杠，枚举和版本严格校验（issue #67）', () => {
  const config = parseWorkspaceConfig(FULL_CONFIG);
  assert.equal(config.rocketChat?.url, 'https://chat.example.com');
  assert.equal(config.ado?.mode, 'direct');
  assert.equal(config.ai?.providers[0].id, 'deepseek');

  assert.throws(() => parseWorkspaceConfig('not json'), /JSON/);
  assert.throws(() => parseWorkspaceConfig('{"version":2}'), /版本/);
  assert.throws(
    () => parseWorkspaceConfig('{"version":1,"ado":{"mode":"magic"}}'),
    /direct \/ bridge/,
  );
  assert.throws(
    () => parseWorkspaceConfig('{"version":1,"rocketChat":{"url":"ftp://x"}}'),
    /http\/https/,
  );
});

test('配置文件是不可信输入：内嵌凭据一律拒绝', () => {
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
    /凭据不进配置文件/,
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
      adoMode: 'direct',
      adoAuth: '',
      adoWebUrl: '',
      templatesUrl: '',
      aiProviders: {},
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
  // 本地值与配置一致：无需改动
  assert.equal(byKey.get('ado.mode')?.unchanged, true);
  assert.equal(byKey.get('ado.mode')?.selected, false);
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
      aiProviders: {},
    },
    lastApplied,
  );
  const byKey = new Map(fields.map((field) => [field.key, field]));

  assert.equal(byKey.get('server.url')?.selected, true);
  assert.equal(byKey.get('server.url')?.overridden, false);
  assert.equal(byKey.get('ado.base')?.selected, false);
  assert.equal(byKey.get('ado.base')?.overridden, true);
});

test('AI Provider 按指纹比对，webUrl 缺省时回退 ado.url', () => {
  const config = parseWorkspaceConfig(FULL_CONFIG);
  const fields = planWorkspaceFields(
    config,
    {
      aiProviders: {
        deepseek: aiProviderFingerprint({
          kind: 'openai-compatible',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-chat',
        }),
      },
    },
    {},
  );
  const byKey = new Map(fields.map((field) => [field.key, field]));

  assert.equal(byKey.get('ai.provider.deepseek')?.unchanged, true);
  assert.equal(byKey.get('ado.webUrl')?.incoming, 'http://ado.example.com/tfs/DefaultCollection');
});

test('应用记录合并：只记录本次应用的字段，未勾选字段保留旧记录', () => {
  const merged = mergeAppliedFields(
    { url: 'https://old', name: '旧', importedAt: 1, applied: { 'server.url': 'a', 'ado.base': 'b' } },
    { url: 'https://new', importedAt: 2 },
    { 'server.url': 'a2' },
  );
  assert.deepEqual(merged, {
    url: 'https://new',
    name: '旧',
    importedAt: 2,
    applied: { 'server.url': 'a2', 'ado.base': 'b' },
  });
});
