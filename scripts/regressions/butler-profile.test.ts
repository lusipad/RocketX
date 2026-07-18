import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PERSONA,
  appendMemory,
  buildButlerSystemPrompt,
  getPersona,
  listMemory,
  listSkills,
  loadButlerSkill,
  rememberButlerFact,
  recallButlerMemory,
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

function withMemoryStorage(run: () => void): void {
  const restore = setButlerProfileStorage(new MemoryStorage());
  try {
    run();
  } finally {
    restore();
  }
}

test('系统提示注入人设和技能索引，并按需注入记忆', () => {
  withMemoryStorage(() => {
    const initial = buildButlerSystemPrompt();
    assert.ok(initial.startsWith(DEFAULT_PERSONA));
    assert.doesNotMatch(initial, /## 你记住的事实/);
    assert.match(initial, /## 可用技能/);
    assert.match(initial, /- morning-brief：/);
    assert.match(initial, /- evening-review：/);
    assert.match(initial, /- weekly-report：/);

    appendMemory('老李是李建国');
    assert.match(buildButlerSystemPrompt(), /## 你记住的事实\n- 老李是李建国/);
  });
});

test('默认人设约束管家使用渲染环境支持的输出格式', () => {
  assert.match(DEFAULT_PERSONA, /不使用 markdown 表格/);
  assert.match(DEFAULT_PERSONA, /粗体小标题/);
  assert.match(DEFAULT_PERSONA, /偏好、纠错、别名、决定或承诺/);
  assert.match(DEFAULT_PERSONA, /先调用 remember/);
});

test('系统提示仅保留最近 30 条记忆，并从最旧项开始压缩到 4000 字符', () => {
  withMemoryStorage(() => {
    for (let index = 0; index < 31; index += 1) appendMemory(`第${index}条`);

    const recentPrompt = buildButlerSystemPrompt();
    assert.equal(listMemory().length, 31);
    assert.doesNotMatch(recentPrompt, /- 第0条/);
    assert.match(recentPrompt, /- 第30条/);

    appendMemory(`旧事实${'甲'.repeat(3990)}`);
    appendMemory(`最新事实${'乙'.repeat(20)}`);
    const compactedPrompt = buildButlerSystemPrompt();
    assert.doesNotMatch(compactedPrompt, /旧事实/);
    assert.match(compactedPrompt, /最新事实/);
  });
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

test('load_skill 与 remember 使用可测试的纯档案逻辑', () => {
  withMemoryStorage(() => {
    assert.match(loadButlerSkill('morning-brief'), /^晨报/);
    assert.match(loadButlerSkill('missing'), /未找到技能：missing，可用技能：morning-brief、evening-review、weekly-report/);
    assert.equal(rememberButlerFact('我偏好简短回复'), '已记住：我偏好简短回复');
    assert.equal(listMemory()[0]?.text, '我偏好简短回复');
    rememberButlerFact('老李是李建国');
    assert.deepEqual(recallButlerMemory('老李').map((entry) => entry.text), ['老李是李建国']);
    assert.equal(rememberButlerFact('  '), '没有可记住的内容。');
  });
});
