import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  AZURE_DEVOPS_SERVER_SKILL_NAME,
  AZURE_DEVOPS_SERVER_SKILL_REVISION,
  DEFAULT_PERSONA,
  buildButlerApiSystemPrompt,
  buildButlerCodexBaseInstructions,
  buildButlerSystemPrompt,
  butlerWorkspaceRevision,
  canUseNativeButlerSkill,
  getPersona,
  listSkills,
  loadButlerSkill,
  removeSkill,
  resetPersona,
  saveSkill,
  setButlerProfileStorage,
  setSkillEnabled,
  setPersona,
  type ButlerProfileStorage,
} from '../../apps/web/src/lib/butlerProfile';
import {
  initializeButlerLearningExtensions,
} from '../../apps/web/src/butler/extensions/learning/runtime';

initializeButlerLearningExtensions();

class MemoryStorage implements ButlerProfileStorage {
  private readonly entries: Map<string, string>;

  constructor(seed?: Iterable<readonly [string, string]>) {
    this.entries = new Map(seed);
  }

  get(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.entries.set(key, value);
  }

  snapshot(): ReadonlyArray<readonly [string, string]> {
    return [...this.entries.entries()];
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
    assert.equal(initial, buildButlerApiSystemPrompt());
    assert.ok(initial.startsWith(DEFAULT_PERSONA));
    assert.doesNotMatch(initial, /## 你记住的事实/);
    assert.match(initial, /## 可用技能/);
    assert.match(initial, /- morning-brief：/);
    assert.match(initial, /- evening-review：/);
    assert.match(initial, /- weekly-report：/);
    assert.match(initial, /- pr-comparison：/);
    assert.match(initial, /- commitment-extraction：/);
    assert.match(initial, /- azure-devops-server：/);
    assert.doesNotMatch(initial, /- compare-pull-requests：/);

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

test('两条管家运行路径都要求把可信来源链接放到对应结论末尾', () => {
  const api = buildButlerApiSystemPrompt();
  const codex = buildButlerCodexBaseInstructions();
  for (const prompt of [api, codex]) {
    assert.match(prompt, /事实性结论/);
    assert.match(prompt, /对应句末/);
    assert.match(prompt, /link.*webUrl/s);
    assert.match(prompt, /不要手写引用编号或编号范围/);
  }
});

test('AI 设置页只保留高级行为指令，名字与性格由我的管家统一管理', () => {
  const settings = readFileSync('apps/web/src/components/AiSettings.tsx', 'utf8');
  assert.match(settings, /label="高级行为指令"/);
  assert.match(settings, /名字、头像和相处方式请在“我的管家”修改/);
  assert.match(settings, /savePersona/);
  assert.match(settings, /restoreDefaultPersona/);
  assert.match(settings, /AI 托管的编码代理和安全纪律不受影响/);
  assert.doesNotMatch(settings, /AXIS_META|loadPersonality|管家性格/);

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
    assert.throws(
      () => saveSkill({
        name: AZURE_DEVOPS_SERVER_SKILL_NAME,
        description: '覆盖托管 Skill',
        body: '不应保存',
      }),
      /托管技能不可修改/,
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
    assert.match(loadButlerSkill('pr-comparison'), /^比较 PR/);
    assert.match(loadButlerSkill('commitment-extraction'), /^提取承诺/);
    assert.match(loadButlerSkill(AZURE_DEVOPS_SERVER_SKILL_NAME), /run_azure_devops_server_cli/);
    assert.match(
      loadButlerSkill('missing'),
      /未找到技能：missing，可用技能：.*butler-profile-curator.*butler-reply-guardian.*azure-devops-server/,
    );
  });
});

test('内置技能默认启用，停用后重启仍保留停用状态', () => {
  withMemoryStorage((storage) => {
    assert.equal(canUseNativeButlerSkill('morning-brief'), true);

    setSkillEnabled('morning-brief', false);
    assert.equal(canUseNativeButlerSkill('morning-brief'), false);

    const rebooted = new MemoryStorage(storage.snapshot());
    const restore = setButlerProfileStorage(rebooted);
    try {
      assert.equal(canUseNativeButlerSkill('morning-brief'), false);
    } finally {
      restore();
    }
  });
});

test('停用后的技能仍出现在管理列表，但不会进入可执行技能清单', () => {
  withMemoryStorage(() => {
    setSkillEnabled('morning-brief', false);

    assert.equal(listSkills().some((skill) => skill.name === 'morning-brief'), true);
    assert.equal(canUseNativeButlerSkill('morning-brief'), false);
    assert.doesNotMatch(loadButlerSkill('morning-brief'), /^晨报/);
    assert.doesNotMatch(buildButlerSystemPrompt(), /- morning-brief：/);
  });
});

test('重新启用后，内置技能重新回到可执行状态', () => {
  withMemoryStorage(() => {
    setSkillEnabled('morning-brief', false);
    setSkillEnabled('morning-brief', true);

    assert.equal(canUseNativeButlerSkill('morning-brief'), true);
    assert.match(loadButlerSkill('morning-brief'), /^晨报/);
    assert.match(buildButlerSystemPrompt(), /- morning-brief：/);
  });
});

test('自装技能删除后会清掉停用状态，重新安装默认恢复启用', () => {
  withMemoryStorage(() => {
    saveSkill({ name: 'release-note', description: '整理发布说明。', body: '# 发布说明' });
    setSkillEnabled('release-note', false);
    assert.equal(canUseNativeButlerSkill('release-note'), false);

    removeSkill('release-note');
    saveSkill({ name: 'release-note', description: '整理发布说明。', body: '# 发布说明' });

    assert.equal(canUseNativeButlerSkill('release-note'), true);
    assert.match(loadButlerSkill('release-note'), /^# 发布说明/);
  });
});

test('内置技能即使被停用，仍不可保存或删除', () => {
  withMemoryStorage(() => {
    setSkillEnabled('morning-brief', false);

    assert.throws(
      () => saveSkill({ name: 'morning-brief', description: '覆盖', body: '不应保存' }),
      /内置技能不可修改/,
    );
    assert.throws(
      () => removeSkill('morning-brief'),
      /内置技能不可修改/,
    );
  });
});

test('Codex 基础指令依赖工作区原生技能，API 提示继续使用 load_skill', () => {
  withMemoryStorage((storage) => {
    setPersona('这个人设只应写入 AGENTS.md。');
    const codex = buildButlerCodexBaseInstructions();
    assert.match(codex, /遵守当前工作目录中的 AGENTS\.md/);
    assert.match(codex, /原生 Agent Skills/);
    assert.doesNotMatch(codex, /## 可用技能/);
    assert.doesNotMatch(codex, /morning-brief：/);
    assert.doesNotMatch(codex, /这个人设只应写入/);

    storage.set('rcx-butler-v1:skills', JSON.stringify([
      { name: '旧 技能', description: '迁移前技能。', body: '继续兼容。' },
    ]));
    assert.match(loadButlerSkill('旧 技能'), /继续兼容/);
    assert.match(buildButlerCodexBaseInstructions(), /旧 技能：迁移前技能/);
    assert.throws(
      () => saveSkill({ name: '新 技能', description: '非法名称。', body: '不应保存。' }),
      /技能名称必须是/,
    );
    assert.throws(
      () => saveSkill({ name: 'empty-skill', description: '空正文。', body: '   ' }),
      /技能正文不能为空/,
    );
  });
});

test('人设或技能内容变化都会改变 Butler 工作区版本', () => {
  withMemoryStorage(() => {
    const initial = butlerWorkspaceRevision();
    assert.match(initial, new RegExp(AZURE_DEVOPS_SERVER_SKILL_REVISION));
    setPersona('新的工作区人设。');
    const personaChanged = butlerWorkspaceRevision();
    assert.notEqual(personaChanged, initial);

    saveSkill({ name: 'release-note', description: '整理发布说明。', body: '先查变更。' });
    const skillChanged = butlerWorkspaceRevision();
    assert.notEqual(skillChanged, personaChanged);
  });
});
