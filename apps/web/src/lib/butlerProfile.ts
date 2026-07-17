export interface ButlerProfileStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface ButlerMemoryEntry {
  id: string;
  text: string;
  at: number;
}

export interface ButlerSkill {
  name: string;
  description: string;
  body: string;
}

const STORAGE_PREFIX = 'rcx-butler-v1:';
const PERSONA_KEY = 'persona';
const MEMORY_KEY = 'memory';
const SKILLS_KEY = 'skills';
const MEMORY_LIMIT = 30;
const MEMORY_CHARACTER_LIMIT = 4000;

export const DEFAULT_PERSONA = `你是 RocketX 管家，服务于 GTD 与注意力保护。

默认回答简洁，先查证据再回答。找不到时明确说没找到，并给出下一步建议。涉及人名、时间等模糊指代时先用工具查询；出现多个候选时列出证据，请用户二选一。绝不编造数据。`;

const TOOL_CAPABILITIES = '你可以查询消息、联系人与会话、待办、日程、工作项、拉取请求和构建。';

export const BUILT_IN_BUTLER_SKILLS: readonly ButlerSkill[] = [
  {
    name: 'morning-brief',
    description: '晨报：梳理今天的待办、日程和构建异常。',
    body: `# 晨报

目标是回答“今天要什么”，只基于工具返回的数据给出简洁建议。

1. 调用 \`list_todos\`，仅查看未完成待办；优先排序今天到期和已逾期的项。
2. 调用 \`list_calendar\` 查询今天的日程，检查时间重叠并标注冲突。
3. 调用 \`list_builds\`，传入 \`failedOnly: true\`，收集失败构建。
4. 输出三段：**待办优先级**、**日程**、**需要关注的异常**。最后给出建议的处理顺序，不重复原始数据。`,
  },
  {
    name: 'evening-review',
    description: '晚间回顾：盘点今天未完成的承诺。',
    body: `# 晚间回顾

目标是回答“今天欠什么”，不猜测未查询到的事项。

1. 调用 \`list_todos\`，只看未完成且今天到期或已逾期的待办。
2. 调用 \`list_calendar\` 查询今天的日程，仅把当前时间已过去的日程作为回顾依据。
3. 输出 **未完成清单**；每条给出一个明确建议：顺延、完成或放弃，并说明简短理由。`,
  },
  {
    name: 'weekly-report',
    description: '周报：按项目汇总本周的 PR、工作项和构建。',
    body: `# 周报

目标是形成可直接发送的周报骨架，所有结论都应可追溯到工具结果。

1. 调用 \`list_pull_requests\`、\`list_work_items\` 和 \`list_builds\` 获取本周相关数据。
2. 按项目分组；PR 只有仓库信息时，归入能确定的项目，否则标为“未归类”。
3. 每个项目依次输出 **本周进展**、**风险**、**下周计划骨架**；风险优先列出失败构建和阻塞中的工作项。`,
  },
];

const localStorageProfile: ButlerProfileStorage = {
  get: (key) => typeof window === 'undefined' ? null : window.localStorage.getItem(key),
  set: (key, value) => {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
  },
};

let profileStorage: ButlerProfileStorage = localStorageProfile;

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

function isMemoryEntry(value: unknown): value is ButlerMemoryEntry {
  return !!value && typeof value === 'object' &&
    typeof (value as ButlerMemoryEntry).id === 'string' &&
    typeof (value as ButlerMemoryEntry).text === 'string' &&
    typeof (value as ButlerMemoryEntry).at === 'number';
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

function memoryForPrompt(): ButlerMemoryEntry[] {
  const recent = listMemory().slice(0, MEMORY_LIMIT);
  let characterCount = recent.reduce((total, entry) => total + entry.text.length, 0);
  while (characterCount > MEMORY_CHARACTER_LIMIT && recent.length > 0) {
    characterCount -= recent.pop()!.text.length;
  }
  return recent;
}

export function setButlerProfileStorage(storage: ButlerProfileStorage): () => void {
  const previous = profileStorage;
  profileStorage = storage;
  return () => {
    profileStorage = previous;
  };
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

export function listMemory(): ButlerMemoryEntry[] {
  const saved = readJson(MEMORY_KEY);
  return (Array.isArray(saved) ? saved.filter(isMemoryEntry) : [])
    .sort((left, right) => right.at - left.at);
}

export function appendMemory(text: string): ButlerMemoryEntry {
  const entry = { id: crypto.randomUUID(), text: text.trim(), at: Date.now() };
  writeJson(MEMORY_KEY, [entry, ...listMemory()]);
  return entry;
}

export function removeMemory(id: string): void {
  writeJson(MEMORY_KEY, listMemory().filter((entry) => entry.id !== id));
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
}

export function loadButlerSkill(name: string): string {
  const skill = listSkills().find((item) => item.name === name);
  if (skill) return skill.body;
  return `未找到技能：${name}，可用技能：${listSkills().map((item) => item.name).join('、')}`;
}

export function rememberButlerFact(fact: string): string {
  const entry = appendMemory(fact);
  return `已记住：${entry.text}`;
}

export function buildButlerSystemPrompt(): string {
  const sections = [getPersona()];
  const memories = memoryForPrompt();
  if (memories.length > 0) {
    sections.push(`## 你记住的事实\n${memories.map((entry) => `- ${entry.text}`).join('\n')}`);
  }
  sections.push([
    '## 可用技能',
    ...listSkills().map((skill) => `- ${skill.name}：${skill.description}`),
    '需要使用某技能的方法论时，先调用 load_skill 工具取其正文再照做。',
  ].join('\n'));
  sections.push(TOOL_CAPABILITIES);
  return sections.join('\n\n');
}

// IndexedDB 迁移将在后续步骤替换当前 localStorage 适配器。
