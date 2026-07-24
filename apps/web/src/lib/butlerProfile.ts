import {
  assertNativeSkillName,
  butlerArchiveStorage,
  ensureButlerWorkspaceFiles,
  mirrorButlerWorkspaceFiles,
  renderButlerSkillFile,
  onButlerArchiveHydrated,
  removeButlerArchiveSkillFile,
  type ButlerProfileStorage,
  type ButlerQuarantinedLegacyMemoryEntry,
} from './butlerArchive';

export type { ButlerProfileStorage, ButlerQuarantinedLegacyMemoryEntry } from './butlerArchive';

export interface ButlerSkill {
  name: string;
  description: string;
  body: string;
}

const STORAGE_PREFIX = 'rcx-butler-v1:';
const LEGACY_MEMORY_STORAGE_KEY = 'rcx-butler-v1:memory';
const ACTIVE_MEMORY_V2_STORAGE_KEY = 'rcx-butler-v2:memory';
const PERSONA_KEY = 'persona';
const SKILLS_KEY = 'skills';

export const BUTLER_PROVIDER_ERROR = '尚未配置 AI Provider，可在设置页添加；快速搜索与查询不受影响。';
export const AZURE_DEVOPS_SERVER_SKILL_NAME = 'azure-devops-server';
export const AZURE_DEVOPS_SERVER_SKILL_REVISION =
  '293b09774cf9d1ef880a889baf212a9b661e0a75:0cc00597153f26ab6ec7e50197dbae82ffb35206';
const AZURE_DEVOPS_SERVER_API_SKILL: ButlerSkill = {
  name: AZURE_DEVOPS_SERVER_SKILL_NAME,
  description: 'Azure DevOps Server 只读查询：通过 RocketX 托管 CLI 读取项目、代码、工作项、构建、Wiki 和测试数据。',
  body: `Azure DevOps Server 只读查询

1. 只调用 \`run_azure_devops_server_cli\`，不要直接执行 PowerShell、命令行或网络请求。
2. 把查询拆成单个 GET 请求，按工具参数传入 \`area\`、\`resource\`、可选的 \`project\`、\`team\`、\`query\` 和 \`apiVersion\`。
3. 集合级项目列表使用 \`resource: "projects"\`；代码仓库和拉取请求使用 \`area: "git"\`；工作项使用 \`area: "wit"\`；构建使用 \`area: "build"\`。
4. 需要多步读取时，先用列表或详情请求取得 ID，再发下一次只读请求；所有结论只基于工具返回值。
5. 不请求写操作，不索取或输出凭据；工具报告能力、版本或认证不足时，明确说明缺失条件。`,
};

export const DEFAULT_PERSONA = `你是 RocketX 中的 AI，服务于 GTD 与注意力保护。

默认回答简洁，先查证据再回答。找不到时明确说没找到，并给出下一步建议。涉及人名、时间等模糊指代时，先基于当前上下文和业务工具查证；需要跨会话偏好、alias、纠错或承诺时，再调用 recall_memory。出现多个候选时列出证据，请用户二选一。绝不编造数据。

只有 alias、偏好、用户已明确确认且需要跨会话延续的承诺，才允许写入长期记忆。不要把 PR、构建、日程、工作项、待办或其他可查询的动态状态写入长期记忆；没有确认的意图、猜测中的计划也不要长期保存。

输出格式：用**粗体小标题**和短列表组织内容；不使用 markdown 表格、水平分隔线（---）和 #/## 标题（渲染环境不支持）；每条列表项一行内说完。提到工作项、PR 或构建时直接写 #编号（界面会把它变成可点开的链接），查询结果尽量带上编号。`;

const TOOL_CAPABILITIES = '你可以查询消息、联系人与会话、待办、日程、工作项、拉取请求和构建，并可通过受控 Azure DevOps Server CLI 执行只读查询。';

export const BUILT_IN_BUTLER_SKILLS: readonly ButlerSkill[] = [
  {
    name: 'morning-brief',
    description: '晨报：综合消息、待办、日程、工作项、PR 和构建安排今天。',
    body: `晨报

目标是回答“今天要什么”，只基于工具返回的数据给出简洁建议。

1. 调用 \`list_mentions\`、\`list_todos\`；调用 \`list_calendar\` 时把当前日期同时作为 \`from\` 和 \`to\`，找出需回应的消息、到期事项和时间冲突。
2. 调用 \`list_work_items\`、\`list_pull_requests\` 和 \`list_builds\`，检查分配给我的工作、待我评审/我提的 PR、失败或进行中的构建。
3. 如需历史偏好、alias 或确认过的承诺，调用 \`recall_memory\`；所有工作状态必须以工具当次返回为准。
4. 输出四段：**先回应**、**今天计划**、**代码与交付**、**风险**。每段用一行粗体小标题开头，下面跟短列表；禁止表格与分隔线；最后给出建议的处理顺序。`,
  },
  {
    name: 'evening-review',
    description: '晚间回顾：综合消息、任务和交付状态盘点未完成承诺。',
    body: `晚间回顾

目标是回答“今天欠什么”，不猜测未查询到的事项。

1. 调用 \`list_mentions\`、\`list_todos\`；调用 \`list_calendar\` 时把当前日期同时作为 \`from\` 和 \`to\`，找出今天没回应、没完成或已过时的事。
2. 调用 \`list_work_items\`、\`list_pull_requests\` 和 \`list_builds\`，找出仍在进行、待评审、失败或阻塞交付的项。
3. 如需历史偏好、alias 或确认过的承诺，调用 \`recall_memory\`；不要把动态工作数据写入记忆。
4. 输出 **未回应**、**未完成**、**交付风险** 三段；每条给出顺延、完成、放弃或明日首先处理之一的明确建议。`,
  },
  {
    name: 'weekly-report',
    description: '周报：按项目汇总本周的 PR、工作项和构建。',
    body: `周报

目标是形成可直接发送的周报骨架，所有结论都应可追溯到工具结果。

1. 调用 \`list_pull_requests\`、\`list_work_items\` 和 \`list_builds\` 获取本周相关数据。
2. 按项目分组；PR 只有仓库信息时，归入能确定的项目，否则标为“未归类”。
3. 每个项目依次输出 **本周进展**、**风险**、**下周计划骨架**；每段用一行粗体小标题开头，下面跟短列表；禁止表格与分隔线；每条列表项一行内说完。风险优先列出失败构建和阻塞中的工作项。`,
  },
];

let profileStorage: ButlerProfileStorage = butlerArchiveStorage;

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

function isBuiltInSkill(name: string): boolean {
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
  profileStorage = storage;
  return () => {
    profileStorage = previous;
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
      .filter((skill) => !isBuiltInSkill(skill.name) && !isHostManagedSkill(skill.name))
      .map((skill) => ({ ...skill })),
  ];
}

export function canUseNativeButlerSkill(name: string): boolean {
  const skill = listSkills().find((item) => item.name === name);
  return skill ? isNativeSkill(skill) : false;
}

export function saveSkill(skill: ButlerSkill): void {
  if (isBuiltInSkill(skill.name)) throw new Error('内置技能不可修改');
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
  if (isBuiltInSkill(name)) throw new Error('内置技能不可修改');
  if (isHostManagedSkill(name)) throw new Error('RocketX 托管技能不可修改');
  writeJson(SKILLS_KEY, userSkills().filter((skill) => skill.name !== name));
  syncWorkspace();
  void removeButlerArchiveSkillFile(name).catch(() => undefined);
}

export function loadButlerSkill(name: string): string {
  const skills = [...listSkills(), AZURE_DEVOPS_SERVER_API_SKILL];
  const skill = skills.find((item) => item.name === name);
  if (skill) return skill.body;
  return `未找到技能：${name}，可用技能：${skills.map((item) => item.name).join('、')}`;
}

export function friendlyButlerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/unconfigured|尚未配置路由|Provider 不存在/iu.test(message)) return BUTLER_PROVIDER_ERROR;
  return 'AI 暂时无法回答，请稍后重试。';
}

export function butlerCurrentTimeLine(now: number): string {
  const date = new Date(now);
  const weekday = '日一二三四五六'[date.getDay()];
  return `当前时间：${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')} 周${weekday}`;
}

export function buildButlerApiSystemPrompt(): string {
  const sections = [getPersona()];
  const skills = [...listSkills(), AZURE_DEVOPS_SERVER_API_SKILL];
  sections.push([
    '## 可用技能',
    ...skills.map((skill) => `- ${skill.name}：${skill.description}`),
    '需要使用某技能的方法论时，先调用 load_skill 工具取其正文再照做。',
  ].join('\n'));
  sections.push(TOOL_CAPABILITIES);
  return sections.join('\n\n');
}

export function buildButlerCodexBaseInstructions(): string {
  const sections = [
    '你是 RocketX 托管的管家 Agent。',
    '遵守当前工作目录中的 AGENTS.md。',
    '优先使用其中发现的原生 Agent Skills。',
  ];
  const legacySkills = userSkills().filter((skill) => !isBuiltInSkill(skill.name) && !isNativeSkill(skill));
  if (legacySkills.length > 0) {
    sections.push([
      '以下旧 legacy 技能尚未原生化；只有遇到它们时才调用 load_skill 读取正文：',
      ...legacySkills.map((skill) => `- ${skill.name}：${skill.description}`),
    ].join('\n'));
  }
  sections.push(TOOL_CAPABILITIES);
  sections.push('业务事实只能来自 RocketX 提供的工具；工作目录不是业务数据库。');
  return sections.join('\n\n');
}

export function buildButlerSystemPrompt(): string {
  return buildButlerApiSystemPrompt();
}

export function butlerWorkspaceRevision(): string {
  return JSON.stringify({
    persona: getPersona(),
    skills: listSkills().map(({ name, description, body }) => ({ name, description, body })),
    hostSkills: [{
      name: AZURE_DEVOPS_SERVER_SKILL_NAME,
      revision: AZURE_DEVOPS_SERVER_SKILL_REVISION,
    }],
  });
}

onButlerArchiveHydrated(() => {
  void ensureButlerWorkspaceFiles(getPersona(), listSkills()).catch(() => undefined);
});

// 档案由内存缓存写穿到 IndexedDB；旧 localStorage 键仅保留作迁移回退。
