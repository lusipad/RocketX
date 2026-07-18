import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryBackend, createRcxStore } from '@rcx/rcx-store';
import {
  butlerArchiveStorage,
  flushButlerArchiveWrites,
  hydrateButlerArchive,
  renderButlerMemoryFile,
  renderButlerSkillFile,
  setButlerArchiveBackend,
  setButlerArchiveFallbackStorage,
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

test('档案写穿先同步更新缓存，随后持久化到 rcx-store', async () => {
  const backend = createMemoryBackend();
  const restoreFallback = setButlerArchiveFallbackStorage(new MemoryStorage());
  const restoreBackend = setButlerArchiveBackend(backend);

  try {
    butlerArchiveStorage.set('rcx-butler-v1:persona', '先给结论。');
    assert.equal(butlerArchiveStorage.get('rcx-butler-v1:persona'), '先给结论。');
    await flushButlerArchiveWrites();

    const stored = await createRcxStore({ backend }).appData.get<Record<string, string>>(APP_ID, ARCHIVE_KEY);
    assert.equal(stored?.['rcx-butler-v1:persona'], '先给结论。');
  } finally {
    restoreBackend();
    restoreFallback();
  }
});

test('空 IndexedDB 从旧 localStorage 一次性迁移档案', async () => {
  const backend = createMemoryBackend();
  const legacy = new MemoryStorage();
  legacy.set('rcx-butler-v1:persona', '旧人设');
  legacy.set('rcx-butler-v1:memory', JSON.stringify([{ id: 'fact-1', text: '偏好简短', at: 1 }]));
  const restoreFallback = setButlerArchiveFallbackStorage(legacy);
  const restoreBackend = setButlerArchiveBackend(backend);

  try {
    await hydrateButlerArchive();
    const stored = await createRcxStore({ backend }).appData.get<Record<string, string>>(APP_ID, ARCHIVE_KEY);
    assert.equal(stored?.['rcx-butler-v1:persona'], '旧人设');
    assert.equal(stored?.['rcx-butler-v1:memory'], legacy.get('rcx-butler-v1:memory'));
    assert.equal(butlerArchiveStorage.get('rcx-butler-v1:persona'), '旧人设');
    assert.equal(legacy.get('rcx-butler-v1:persona'), '旧人设');
  } finally {
    restoreBackend();
    restoreFallback();
  }
});

test('已有 IndexedDB 档案覆盖旧 localStorage 缓存', async () => {
  const backend = createMemoryBackend();
  await createRcxStore({ backend }).appData.set(APP_ID, ARCHIVE_KEY, {
    'rcx-butler-v1:persona': 'IndexedDB 人设',
    'rcx-butler-v1:skills': '[]',
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
    assert.equal(butlerArchiveStorage.get('rcx-butler-v1:memory'), null);
  } finally {
    restoreBackend();
    restoreFallback();
  }
});

test('档案镜像的技能和记忆 Markdown 内容稳定', () => {
  assert.equal(
    renderButlerSkillFile({ name: 'morning-brief', description: '晨报。', body: '先查待办。' }),
    '# morning-brief\n晨报。\n\n先查待办。\n',
  );
  assert.equal(
    renderButlerMemoryFile([{ text: '我偏好简短回复', at: Date.UTC(2026, 0, 2, 3, 4, 5) }]),
    'AI 保存的事实，供 AI 只读参考。\n\n- [2026-01-02T03:04:05.000Z] 我偏好简短回复\n',
  );
});
