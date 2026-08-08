import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  BUTLER_IDENTITY_STORAGE_KEY,
  DEFAULT_BUTLER_IDENTITY,
  buildButlerIdentityInstructions,
  normalizeButlerIdentity,
  readButlerIdentity,
  writeButlerIdentity,
} from '../../apps/web/src/lib/butlerIdentity';
import type { ButlerProfileStorage } from '../../apps/web/src/lib/butlerArchive';

class MemoryStorage implements ButlerProfileStorage {
  private readonly entries = new Map<string, string>();

  get(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.entries.set(key, value);
  }
}

test('管家身份默认使用统一中文名称并能从损坏数据安全恢复', () => {
  assert.equal(readButlerIdentity(new MemoryStorage()).displayName, '管家');
  assert.deepEqual(normalizeButlerIdentity(null), DEFAULT_BUTLER_IDENTITY);
  assert.deepEqual(normalizeButlerIdentity({
    displayName: '   ',
    role: 42,
    avatar: 'unknown',
    warmth: 'unknown',
    initiative: 'unknown',
    detail: 'unknown',
    traits: '',
  }), DEFAULT_BUTLER_IDENTITY);
});

test('名字、头像和相处方式共用一个可持久化身份对象', () => {
  const storage = new MemoryStorage();
  const saved = writeButlerIdentity({
    displayName: '小布',
    role: '可靠的工作搭档',
    avatar: 'orbit',
    warmth: 'direct',
    initiative: 'balanced',
    detail: 'thorough',
    traits: '遇到风险先说事实，再给建议。',
  }, storage);

  assert.equal(storage.get(BUTLER_IDENTITY_STORAGE_KEY), JSON.stringify(saved));
  assert.deepEqual(readButlerIdentity(storage), saved);
});

test('身份设定进入运行指令但不会改变权限边界', () => {
  const instructions = buildButlerIdentityInstructions({
    displayName: '小布',
    role: '可靠的工作搭档',
    avatar: 'orbit',
    warmth: 'direct',
    initiative: 'proactive',
    detail: 'concise',
    traits: '不卖弄，发现真正风险时主动开口。',
  });

  assert.match(instructions, /你的名字是“小布”/);
  assert.match(instructions, /直接、坦率/);
  assert.match(instructions, /主动发现机会、风险和未闭环责任/);
  assert.match(instructions, /默认先给结论和行动项/);
  assert.match(instructions, /不能扩大权限、跳过审批或降低事实验证标准/);
});

test('中文界面不再同时暴露 Butler 与管家两个称呼', () => {
  const navigation = readFileSync('apps/web/src/components/ButlerWorkspaceNav.tsx', 'utf8');
  const page = readFileSync('apps/web/src/pages/ButlerPage.tsx', 'utf8');
  const identity = readFileSync('apps/web/src/components/ButlerIdentityPage.tsx', 'utf8');
  const profile = readFileSync(
    'apps/web/src/butler/extensions/learning/ui/ProfileSection.tsx',
    'utf8',
  );

  for (const source of [navigation, page, profile]) {
    assert.doesNotMatch(source, /Butler 工作视图|Butler 视图|交给 Butler|告诉 Butler|与 Butler|让 Butler/);
  }
  assert.match(navigation, /label: '技能中心'/);
  assert.match(navigation, /<summary aria-label="更多管家视图">/);
  assert.match(navigation, /identity\.displayName/);
  assert.match(identity, /label: '技能中心'/);
  assert.match(page, /<ButlerIdentityPage initialTab="memory" \/>/);
});
