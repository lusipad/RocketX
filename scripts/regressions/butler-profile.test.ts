import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DEFAULT_PERSONA,
  buildButlerSystemPrompt,
  getPersona,
  listSkills,
  loadButlerSkill,
  removeSkill,
  resetPersona,
  saveSkill,
  setButlerProfileStorage,
  setPersona,
  type ButlerProfileStorage,
} from '../../apps/web/src/lib/butlerProfile';

class MemoryStorage implements ButlerProfileStorage {
  private readonly entries = new Map<string, string>();

  get(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.entries.set(key, value);
  }
}

function withMemoryStorage(run: (storage: MemoryStorage) => void): void {
  const storage = new MemoryStorage();
  const restore = setButlerProfileStorage(storage);
  try {
    run(storage);
  } finally {
    restore();
  }
}

test('系统提示只注入人设和技能索引，永不内嵌任何记忆事实', () => {
  withMemoryStorage((storage) => {
    const initial = buildButlerSystemPrompt();
    assert.ok(initial.startsWith(DEFAULT_PERSONA));
    assert.doesNotMatch(initial, /## 你记住的事实/);
    assert.match(initial, /## 可用技能/);
    assert.match(initial, /- morning-brief：/);
    assert.match(initial, /- evening-review：/);
    assert.match(initial, /- weekly-report：/);

    storage.set('rcx-butler-v1:memory', JSON.stringify([{ id: 'fact-1', text: '老李是李建国', at: 1 }]));
    storage.set('rcx-butler-v2:memory', '{"scopes":{"global":{"entries":[{"id":"fact-2","text":"偏好简短"}]}}}');
    const prompt = buildButlerSystemPrompt();
    assert.doesNotMatch(prompt, /老李是李建国|偏好简短/);
    assert.doesNotMatch(prompt, /## 你记住的事实/);
    assert.match(prompt, /recall_memory/);
  });
});

test('默认人设改为按需 recall_memory，并严格限制可持久化内容', () => {
  assert.match(DEFAULT_PERSONA, /recall_memory/);
  assert.match(DEFAULT_PERSONA, /alias/);
  assert.match(DEFAULT_PERSONA, /偏好/);
  assert.match(DEFAULT_PERSONA, /承诺/);
  assert.match(DEFAULT_PERSONA, /PR、构建、日程、工作项、待办/);
  assert.doesNotMatch(DEFAULT_PERSONA, /先调用 remember/);
});

test('AI 设置页提供人设编辑入口，托管纪律不受人设影响', () => {
  const settings = readFileSync('apps/web/src/components/AiSettings.tsx', 'utf8');
  assert.match(settings, /label="人设"/);
  assert.match(settings, /savePersona/);
  assert.match(settings, /restoreDefaultPersona/);
  assert.match(settings, /AI 托管的编码代理和安全纪律不受影响/);

  const context = readFileSync('apps/web/src/agent/context.ts', 'utf8');
  assert.doesNotMatch(context, /getPersona|DEFAULT_PERSONA|buildButlerSystemPrompt/);
});

test('人设可覆盖和复位，自定义技能可保存和删除', () => {
  withMemoryStorage(() => {
    setPersona('以后先给结论。');
    assert.equal(getPersona(), '以后先给结论。');
    resetPersona();
    assert.equal(getPersona(), DEFAULT_PERSONA);
    assert.throws(
      () => saveSkill({ name: 'morning-brief', description: '覆盖', body: '不应保存' }),
      /内置技能不可修改/,
    );

    saveSkill({ name: 'release-note', description: '整理发布说明。', body: '# 发布说明' });
    assert.ok(listSkills().some((skill) => skill.name === 'release-note'));
    assert.match(buildButlerSystemPrompt(), /- release-note：整理发布说明。/);
    removeSkill('release-note');
    assert.equal(listSkills().some((skill) => skill.name === 'release-note'), false);
  });
});

test('profile 源码不再导出让 legacy memory 变成活动记忆的旧 API', () => {
  const source = readFileSync('apps/web/src/lib/butlerProfile.ts', 'utf8');
  assert.doesNotMatch(source, /export function appendMemory/);
  assert.doesNotMatch(source, /export function listMemory/);
  assert.doesNotMatch(source, /export function recallButlerMemory/);
  assert.doesNotMatch(source, /export function removeMemory/);
  assert.doesNotMatch(source, /export function rememberButlerFact/);
  assert.match(source, /readButlerActiveMemoryV2RawJson/);
  assert.match(source, /listButlerQuarantinedLegacyMemory/);
});

test('load_skill 仍可用，skills 合同不受记忆隔离影响', () => {
  withMemoryStorage(() => {
    assert.match(loadButlerSkill('morning-brief'), /^晨报/);
    assert.match(loadButlerSkill('missing'), /未找到技能：missing，可用技能：morning-brief、evening-review、weekly-report/);
  });
});
