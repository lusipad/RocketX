import {
  assertNativeSkillName,
  butlerArchiveStorage,
  mirrorButlerWorkspaceFiles,
  renderButlerSkillFile,
  onButlerArchiveHydrated,
  removeButlerArchiveSkillFile,
  type ButlerProfileStorage,
  type ButlerQuarantinedLegacyMemoryEntry,
} from './butlerArchive';
import { bundledButlerSkills } from './butlerBundledSkills';
import { buildButlerIdentityInstructions, readButlerIdentity } from './butlerIdentity';
import type { ButlerSkill } from './butlerSkill';

export type { ButlerProfileStorage, ButlerQuarantinedLegacyMemoryEntry } from './butlerArchive';
export type { ButlerSkill } from './butlerSkill';

const STORAGE_PREFIX = 'rcx-butler-v1:';
const LEGACY_MEMORY_STORAGE_KEY = 'rcx-butler-v1:memory';
const ACTIVE_MEMORY_V2_STORAGE_KEY = 'rcx-butler-v2:memory';
const PERSONA_KEY = 'persona';
const SKILLS_KEY = 'skills';
const DISABLED_SKILLS_KEY = 'disabled-skills';
const NATIVE_SKILL_CONFIG_MIGRATED_KEY = 'native-skill-config-migrated-v1';

export const BUTLER_PROVIDER_ERROR = '尚未配置 AI Provider，可在设置页添加；快速搜索与查询不受影响。';
export const AZURE_DEVOPS_SERVER_SKILL_NAME = 'azure-devops-server';
export const AZURE_DEVOPS_SERVER_SKILL_REVISION =
  '293b09774cf9d1ef880a889baf212a9b661e0a75:0cc00597153f26ab6ec7e50197dbae82ffb35206:read-post-v1';
export const BUTLER_MEMORY_SKILL_UPSTREAM = {
  repository: 'https://github.com/mem0ai/mem0',
  revision: '74f6dc6f0d60906c4babf762fc8d14b7169c196c',
  license: 'Apache-2.0',
} as const;
const [AZURE_DEVOPS_SERVER_API_SKILL] = bundledButlerSkills('host');

export const DEFAULT_PERSONA = `你是 RocketX 中的 AI，服务于 GTD 与注意力保护。

默认回答简洁，先查证据再回答。找不到时明确说没找到，并给出下一步建议。涉及人名、时间等模糊指代时，先基于当前上下文和业务工具查证；需要跨会话偏好、alias、纠错或承诺时，遵循 butler-memory Skill。出现多个候选时列出证据，请用户二选一。绝不编造数据。

长期记忆的硬边界不变：只有 alias、偏好、用户已明确确认且需要跨会话延续的承诺可以持久化；PR、构建、日程、工作项、待办和其他可查询的动态状态不得写入。

输出格式：用**粗体小标题**和短列表组织内容；不使用 markdown 表格、水平分隔线（---）和 #/## 标题（渲染环境不支持）；每条列表项一行内说完。提到工作项、PR 或构建时，优先直接使用工具结果里的 webUrl 写成 [工作项 #编号 · 标题](webUrl)、[PR #编号 · 标题](webUrl) 或 [构建 #编号 · 定义名](webUrl)；没有 webUrl 时明确说明缺少链接，禁止只写孤立 #数字。`;

const TOOL_CAPABILITIES = '业务工具只作为 Skill 的底层数据与审批适配器。消息、联系人、待办、日程和当前对话派活按适用 Skill 查询；Azure DevOps Server 事实只由 azure-devops-server Skill 通过 RocketX 业务 MCP 实时读取，不读取工作台已加载快照。';
const CITATION_INSTRUCTIONS = [
  '使用工具回答事实时，每条事实性结论都要在对应句末附上它实际使用的来源链接。',
  '链接只能原样取自工具结果的 link 或 webUrl 字段，写成 [来源](链接)；一条结论使用多个来源时分别附上多个链接。',
  '没有链接就明确缺少可引用链接，不得编造；不要手写引用编号或编号范围，界面会把可信链接转换成编号角标。',
].join('\n');

/**
 * 用户问「派出去的活在哪看 / 怎么批准」时的正确答案。
 *
 * 不写这段，管家只能靠猜——真机上它答的是「执行间会出现待批准的卡片」，
 * 把用户往一个他不该去的地方赶。管家必须知道自己长什么样。
 */
const ERRAND_SURFACE = [
  '关于派活：你用 draft_errand 拟规格卡，用户在卡上选工作区并确认后才真正开跑。',
  '用户询问派出去的活现在怎样时，调用 list_errands；用户补充要求、纠正方向或说“继续刚才那件事”时，调用 steer_errand 继续原任务，绝不另拟一张新任务卡。',
  '开跑后一切都留在管家界面：进度、需要用户点头的请求、以及最终结果都显示在「派出去的活」卡片上，用户直接在卡上点「让它跑 / 这次不行」即可。',
  '用户离开管家页时，导航栏「管家」会出现小圆点提醒。',
  '**不要让用户去执行间**——执行间只是想看命令级细节时的可选去处，不是查看进度或批准的地方。',
].join('\n');

const ACTION_SURFACE = [
  '关于把回答变成动作：用户明确说“把这个转成待办”“帮我拟回复”“帮我回复”“发出去”“记成承诺”“建 ADO”或“交给 Codex”时，调用 draft_action，不要只描述操作步骤。',
  '“建 ADO”仍是创建一个新工作项；如果用户说“把 #123 改成已解决”这类修改既有工作项状态的话，调用 draft_ado_state，而不是 draft_action。',
  '“帮我拟回复”对应 kind=reply，只放原会话编辑框；“帮我回复”或“发出去”对应 kind=send，必须经过确认卡后才真正发送。',
  'draft_action 和 draft_ado_state 都只打开一张可编辑确认卡；用户确认前不得声称已经创建、发送、记录、改好状态或交接。',
].join('\n');

export const BUILT_IN_BUTLER_SKILLS: readonly ButlerSkill[] =
  bundledButlerSkills('core');

let profileStorage: ButlerProfileStorage = butlerArchiveStorage;
let nativeSkillEnabled = new Map<string, boolean>();

function storageKey(key: string): string {
  return `${STORAGE_PREFIX}${key}`;
}

function readJson(key: string): unknown {
  const raw = profileStorage.get(storageKey(key));
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function writeJson(key: string, value: unknown): void {
  profileStorage.set(storageKey(key), JSON.stringify(value));
}

function isSkill(value: unknown): value is ButlerSkill {
  return !!value && typeof value === 'object' &&
    typeof (value as ButlerSkill).name === 'string' &&
    typeof (value as ButlerSkill).description === 'string' &&
    typeof (value as ButlerSkill).body === 'string';
}

function userSkills(): ButlerSkill[] {
  const saved = readJson(SKILLS_KEY);
  return Array.isArray(saved) ? saved.filter(isSkill) : [];
}

function disabledSkillNames(): string[] {
  const saved = readJson(DISABLED_SKILLS_KEY);
  if (!Array.isArray(saved)) return [];
  return [...new Set(saved.filter((name): name is string =>
    typeof name === 'string' && !!name.trim()))];
}

export function isButlerBuiltInSkill(name: string): boolean {
  return BUILT_IN_BUTLER_SKILLS.some((skill) => skill.name === name);
}

function isHostManagedSkill(name: string): boolean {
  return name === AZURE_DEVOPS_SERVER_SKILL_NAME;
}

function isNativeSkill(skill: ButlerSkill): boolean {
  try {
    renderButlerSkillFile(skill);
    return true;
  } catch {
    return false;
  }
}

function syncWorkspace(): void {
  void mirrorButlerWorkspaceFiles(getPersona(), listSkills());
}

export function setButlerProfileStorage(storage: ButlerProfileStorage): () => void {
  const previous = profileStorage;
  const previousNativeSkillEnabled = nativeSkillEnabled;
  profileStorage = storage;
  nativeSkillEnabled = new Map();
  return () => {
    profileStorage = previous;
    nativeSkillEnabled = previousNativeSkillEnabled;
  };
}

function isQuarantinedLegacyMemoryEntry(value: unknown): value is ButlerQuarantinedLegacyMemoryEntry {
  return !!value && typeof value === 'object'
    && typeof (value as ButlerQuarantinedLegacyMemoryEntry).id === 'string'
    && typeof (value as ButlerQuarantinedLegacyMemoryEntry).text === 'string'
    && typeof (value as ButlerQuarantinedLegacyMemoryEntry).at === 'number';
}

export function readButlerActiveMemoryV2RawJson(): string | null {
  return profileStorage.get(ACTIVE_MEMORY_V2_STORAGE_KEY);
}

export function writeButlerActiveMemoryV2RawJson(rawJson: string): void {
  profileStorage.set(ACTIVE_MEMORY_V2_STORAGE_KEY, rawJson);
}

export function listButlerQuarantinedLegacyMemory(): ButlerQuarantinedLegacyMemoryEntry[] {
  const raw = profileStorage.get(LEGACY_MEMORY_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isQuarantinedLegacyMemoryEntry) : [];
  } catch {
    return [];
  }
}

export function getPersona(): string {
  return profileStorage.get(storageKey(PERSONA_KEY)) || DEFAULT_PERSONA;
}

export function setPersona(text: string): void {
  profileStorage.set(storageKey(PERSONA_KEY), text);
  syncWorkspace();
}

export function resetPersona(): void {
  profileStorage.set(storageKey(PERSONA_KEY), '');
  syncWorkspace();
}

export function listSkills(): ButlerSkill[] {
  return [
    ...BUILT_IN_BUTLER_SKILLS.map((skill) => ({ ...skill })),
    ...userSkills()
      .filter((skill) => !isButlerBuiltInSkill(skill.name) && !isHostManagedSkill(skill.name))
      .map((skill) => ({ ...skill })),
  ];
}

export function listEnabledSkills(): ButlerSkill[] {
  const disabled = new Set(disabledSkillNames());
  return listSkills().filter((skill) =>
    nativeSkillEnabled.get(skill.name) ?? !disabled.has(skill.name));
}

export function isButlerSkillEnabled(name: string): boolean {
  return listEnabledSkills().some((skill) => skill.name === name);
}

export function setSkillEnabled(name: string, enabled: boolean): void {
  if (!listSkills().some((skill) => skill.name === name)) {
    throw new Error(`未找到技能：${name}`);
  }
  const disabled = new Set(disabledSkillNames());
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  writeJson(DISABLED_SKILLS_KEY, [...disabled]);
  nativeSkillEnabled.set(name, enabled);
  syncWorkspace();
}

export function setButlerNativeSkillStates(
  skills: readonly { name: string; enabled: boolean }[],
): void {
  nativeSkillEnabled = new Map(skills.map((skill) => [skill.name, skill.enabled]));
}

export function clearButlerNativeSkillStates(): void {
  nativeSkillEnabled = new Map();
}

export function legacyButlerSkillConfigMigration(): {
  disabledNames: string[];
} | undefined {
  if (profileStorage.get(storageKey(NATIVE_SKILL_CONFIG_MIGRATED_KEY)) === '1') {
    return undefined;
  }
  return { disabledNames: disabledSkillNames() };
}

export function markButlerSkillConfigMigrated(): void {
  profileStorage.set(storageKey(NATIVE_SKILL_CONFIG_MIGRATED_KEY), '1');
}

export function canUseNativeButlerSkill(name: string): boolean {
  const skill = listEnabledSkills().find((item) => item.name === name);
  return skill ? isNativeSkill(skill) : false;
}

export function saveSkill(skill: ButlerSkill): void {
  if (isButlerBuiltInSkill(skill.name)) throw new Error('内置技能不可修改');
  if (isHostManagedSkill(skill.name)) throw new Error('RocketX 托管技能不可修改');
  const normalized = {
    name: assertNativeSkillName(skill.name),
    description: skill.description.trim(),
    body: skill.body.trim(),
  };
  renderButlerSkillFile(normalized);
  const skills = userSkills();
  const index = skills.findIndex((item) => item.name === normalized.name);
  if (index === -1) skills.push(normalized);
  else skills[index] = normalized;
  writeJson(SKILLS_KEY, skills);
  syncWorkspace();
}

export function removeSkill(name: string): void {
  if (isButlerBuiltInSkill(name)) throw new Error('内置技能不可修改');
  if (isHostManagedSkill(name)) throw new Error('RocketX 托管技能不可修改');
  writeJson(SKILLS_KEY, userSkills().filter((skill) => skill.name !== name));
  writeJson(DISABLED_SKILLS_KEY, disabledSkillNames().filter((skillName) => skillName !== name));
  nativeSkillEnabled.delete(name);
  syncWorkspace();
  void removeButlerArchiveSkillFile(name).catch(() => undefined);
}

export function loadButlerSkill(name: string): string {
  if (listSkills().some((skill) => skill.name === name) && !isButlerSkillEnabled(name)) {
    return `技能已停用：${name}。请先在“技能中心”中重新启用。`;
  }
  const skills = [...listEnabledSkills(), AZURE_DEVOPS_SERVER_API_SKILL];
  const skill = skills.find((item) => item.name === name);
  if (skill) return skill.body;
  return `未找到技能：${name}，可用技能：${skills.map((item) => item.name).join('、')}`;
}

export function friendlyButlerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/unconfigured|尚未配置路由|Provider 不存在/iu.test(message)) return BUTLER_PROVIDER_ERROR;
  if (/^(?:未安装 Skill|Skill 已停用)：/u.test(message)) return message;
  return 'AI 暂时无法回答，请稍后重试。';
}

export function butlerCurrentTimeLine(now: number): string {
  const date = new Date(now);
  const weekday = '日一二三四五六'[date.getDay()];
  return `当前时间：${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')} 周${weekday}`;
}

export function buildButlerApiSystemPrompt(): string {
  const sections = [getPersona(), buildButlerIdentityInstructions(), CITATION_INSTRUCTIONS];
  const skills = [...listEnabledSkills(), AZURE_DEVOPS_SERVER_API_SKILL];
  sections.push([
    '## 可用技能',
    ...skills.map((skill) => `- ${skill.name}：${skill.description}`),
    '需要使用某技能的方法论时，先调用 load_skill 工具取其正文再照做。',
  ].join('\n'));
  sections.push(TOOL_CAPABILITIES);
  sections.push(ACTION_SURFACE);
  return sections.join('\n\n');
}

export function buildButlerCodexBaseInstructions(): string {
  const sections = [
    '你是 RocketX 托管的管家 Agent。',
    buildButlerIdentityInstructions(),
    '遵守当前工作目录中的 AGENTS.md。',
    '所有可重复的业务行为都先由其中发现的原生 Agent Skills 决定方法、追问和工具顺序。自然语言默认使用 Codex 隐式 Skill 发现；只有用户显式输入 $skill 时才固定使用对应 Skill。不要根据宿主任务标签自行选择或替代 Skill。',
  ];
  sections.push(TOOL_CAPABILITIES);
  sections.push(ACTION_SURFACE);
  sections.push(ERRAND_SURFACE);
  sections.push(CITATION_INSTRUCTIONS);
  sections.push('业务事实只能来自 RocketX 提供的工具；工作目录不是业务数据库。');
  return sections.join('\n\n');
}

export function buildButlerSystemPrompt(): string {
  return buildButlerApiSystemPrompt();
}

export function butlerWorkspaceRevision(): string {
  return JSON.stringify({
    identity: readButlerIdentity(),
    persona: getPersona(),
    skills: listEnabledSkills().map((skill) =>
      skill.source ?? {
        name: skill.name,
        description: skill.description,
        body: skill.body,
      }),
    hostSkills: [{
      name: AZURE_DEVOPS_SERVER_SKILL_NAME,
      revision: AZURE_DEVOPS_SERVER_SKILL_REVISION,
    }],
  });
}

onButlerArchiveHydrated(() => {
  syncWorkspace();
});

// 档案由内存缓存写穿到 IndexedDB；旧 localStorage 键仅保留作迁移回退。
