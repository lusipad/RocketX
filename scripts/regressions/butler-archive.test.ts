import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createMemoryBackend, createRcxStore } from '@rcx/rcx-store';
import {
  butlerArchiveStorage,
  flushButlerArchiveWrites,
  hydrateButlerArchive,
  listButlerQuarantinedLegacyMemory,
  readButlerActiveMemoryV2RawJson,
  renderButlerSkillFile,
  setButlerArchiveBackend,
  setButlerArchiveFallbackStorage,
  writeButlerActiveMemoryV2RawJson,
  type ButlerProfileStorage,
} from '../../apps/web/src/lib/butlerArchive';

const APP_ID = 'rocketx.butler';
const ARCHIVE_KEY = 'archive';

class MemoryStorage implements ButlerProfileStorage {
  private readonly entries = new Map<string, string>();

  get(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.entries.set(key, value);
  }
}

test('档案写穿先同步更新缓存，随后持久化 rcx-butler-v2:memory', async () => {
  const backend = createMemoryBackend();
  const restoreFallback = setButlerArchiveFallbackStorage(new MemoryStorage());
  const restoreBackend = setButlerArchiveBackend(backend);

  try {
    writeButlerActiveMemoryV2RawJson('{"scopes":{"global":{"entries":[]}}}');
    assert.equal(readButlerActiveMemoryV2RawJson(), '{"scopes":{"global":{"entries":[]}}}');
    await flushButlerArchiveWrites();

    const stored = await createRcxStore({ backend }).appData.get<Record<string, string>>(APP_ID, ARCHIVE_KEY);
    assert.equal(stored?.['rcx-butler-v2:memory'], '{"scopes":{"global":{"entries":[]}}}');
  } finally {
    restoreBackend();
    restoreFallback();
  }
});

test('空 IndexedDB 从旧 localStorage 一次性迁移 v1 memory 到 quarantine，但不会变成活动 recall', async () => {
  const backend = createMemoryBackend();
  const legacy = new MemoryStorage();
  legacy.set('rcx-butler-v1:persona', '旧人设');
  legacy.set('rcx-butler-v1:memory', JSON.stringify([
    { id: 'fact-1', text: '偏好简短', at: 1 },
    { id: 'broken', text: 42, at: 2 },
  ]));
  const restoreFallback = setButlerArchiveFallbackStorage(legacy);
  const restoreBackend = setButlerArchiveBackend(backend);

  try {
    await hydrateButlerArchive();
    const stored = await createRcxStore({ backend }).appData.get<Record<string, string>>(APP_ID, ARCHIVE_KEY);
    assert.equal(stored?.['rcx-butler-v1:persona'], '旧人设');
    assert.equal(stored?.['rcx-butler-v1:memory'], legacy.get('rcx-butler-v1:memory'));
    assert.equal(readButlerActiveMemoryV2RawJson(), null);
    assert.deepEqual(listButlerQuarantinedLegacyMemory(), [{ id: 'fact-1', text: '偏好简短', at: 1 }]);
  } finally {
    restoreBackend();
    restoreFallback();
  }
});

test('已有 IndexedDB 档案覆盖旧 localStorage 缓存，并保留活动 v2 memory', async () => {
  const backend = createMemoryBackend();
  await createRcxStore({ backend }).appData.set(APP_ID, ARCHIVE_KEY, {
    'rcx-butler-v1:persona': 'IndexedDB 人设',
    'rcx-butler-v1:skills': '[]',
    'rcx-butler-v2:memory': '{"scopes":{"global":{"entries":[{"id":"fact-2"}]}}}',
  });
  const legacy = new MemoryStorage();
  legacy.set('rcx-butler-v1:persona', '旧人设');
  legacy.set('rcx-butler-v1:memory', '旧记忆');
  const restoreFallback = setButlerArchiveFallbackStorage(legacy);
  const restoreBackend = setButlerArchiveBackend(backend);

  try {
    await hydrateButlerArchive();
    assert.equal(butlerArchiveStorage.get('rcx-butler-v1:persona'), 'IndexedDB 人设');
    assert.equal(butlerArchiveStorage.get('rcx-butler-v1:skills'), '[]');
    assert.equal(readButlerActiveMemoryV2RawJson(), '{"scopes":{"global":{"entries":[{"id":"fact-2"}]}}}');
    assert.deepEqual(listButlerQuarantinedLegacyMemory(), []);
  } finally {
    restoreBackend();
    restoreFallback();
  }
});

test('桌面档案镜像只保留 skills，并 best-effort 删除 legacy facts.md', () => {
  assert.equal(
    renderButlerSkillFile({ name: 'morning-brief', description: '晨报。', body: '先查待办。' }),
    '# morning-brief\n晨报。\n\n先查待办。\n',
  );

  const source = readFileSync('apps/web/src/lib/butlerArchive.ts', 'utf8');
  assert.doesNotMatch(source, /renderButlerMemoryFile/);
  assert.match(source, /memory\/facts\.md/);
  assert.match(source, /await removeLegacyFactsFile\(homeDir, remove\)/);
});
