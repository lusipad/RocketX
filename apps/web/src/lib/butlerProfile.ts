import {
  butlerArchiveStorage,
  mirrorButlerArchiveFiles,
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

export const DEFAULT_PERSONA = `你是 RocketX 中的 AI，服务于 GTD 与注意力保护。

默认回答简洁，先查证据再回答。找不到时明确说没找到，并给出下一步建议。涉及人名、时间等模糊指代时，先基于当前上下文和业务工具查证；需要跨会话偏好、alias、纠错或承诺时，再调用 recall_memory。出现多个候选时列出证据，请用户二选一。绝不编造数据。

只有 alias、偏好、用户已明确确认且需要跨会话延续的承诺，才允许写入长期记忆。不要把 PR、构建、日程、工作项、待办或其他可查询的动态状态写入长期记忆；没有确认的意图、猜测中的计划也不要长期保存。

输出格式：用**粗体小标题**和短列表组织内容；不使用 markdown 表格、水平分隔线（---）和 #/## 标题（渲染环境不支持）；每条列表项一行内说完。提到工作项、PR 或构建时直接写 #编号（界面会把它变成可点开的链接），查询结果尽量带上编号。`;

const TOOL_CAPABILITIES = '你可以查询消息、联系人与会话、待办、日程、工作项、拉取请求和构建。';

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
  if (key === SKILLS_KEY) {
    void mirrorButlerArchiveFiles(listSkills());
  }
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
}

export function resetPersona(): void {
  profileStorage.set(storageKey(PERSONA_KEY), '');
}

export function listSkills(): ButlerSkill[] {
  return [
    ...BUILT_IN_BUTLER_SKILLS.map((skill) => ({ ...skill })),
    ...userSkills().filter((skill) => !isBuiltInSkill(skill.name)).map((skill) => ({ ...skill })),
  ];
}

export function saveSkill(skill: ButlerSkill): void {
  if (isBuiltInSkill(skill.name)) throw new Error('内置技能不可修改');
  const skills = userSkills();
  const index = skills.findIndex((item) => item.name === skill.name);
  if (index === -1) skills.push({ ...skill });
  else skills[index] = { ...skill };
  writeJson(SKILLS_KEY, skills);
}

export function removeSkill(name: string): void {
  if (isBuiltInSkill(name)) throw new Error('内置技能不可修改');
  writeJson(SKILLS_KEY, userSkills().filter((skill) => skill.name !== name));
  void removeButlerArchiveSkillFile(name);
}

export function loadButlerSkill(name: string): string {
  const skill = listSkills().find((item) => item.name === name);
  if (skill) return skill.body;
  return `未找到技能：${name}，可用技能：${listSkills().map((item) => item.name).join('、')}`;
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

export function buildButlerSystemPrompt(): string {
  const sections = [getPersona()];
  sections.push([
    '## 可用技能',
    ...listSkills().map((skill) => `- ${skill.name}：${skill.description}`),
    '需要使用某技能的方法论时，先调用 load_skill 工具取其正文再照做。',
  ].join('\n'));
  sections.push(TOOL_CAPABILITIES);
  return sections.join('\n\n');
}

onButlerArchiveHydrated(() => {
  void mirrorButlerArchiveFiles(listSkills());
});

// 档案由内存缓存写穿到 IndexedDB；旧 localStorage 键仅保留作迁移回退。
