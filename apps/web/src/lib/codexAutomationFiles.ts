import { isTauriRuntime } from './client';

export type CodexAutomationStatus = 'ACTIVE' | 'PAUSED';

export interface CodexAutomationDefinition {
  version?: number;
  id: string;
  kind: string;
  name: string;
  prompt: string;
  status: CodexAutomationStatus;
  rrule: string;
  cwds: string[];
  executionEnvironment: string;
  createdAt: number | string;
  updatedAt: number | string;
  model?: string;
  reasoningEffort?: string;
  target?: string;
  targetThreadId?: string;
}

export interface CodexAutomationSource {
  id: string;
  content: string;
}

export interface CodexAutomationFileAdapter {
  list: () => Promise<CodexAutomationSource[]>;
  write: (id: string, content: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

const nativeAdapter: CodexAutomationFileAdapter = {
  list: async () => {
    if (!isTauriRuntime()) return [];
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<CodexAutomationSource[]>('codex_automation_list');
  },
  write: async (id, content) => {
    if (!isTauriRuntime()) return;
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke<void>('codex_automation_write', { id, content });
  },
  remove: async (id) => {
    if (!isTauriRuntime()) return;
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke<void>('codex_automation_delete', { id });
  },
};

let fileAdapter = nativeAdapter;
let customAdapter = false;

export function setCodexAutomationFileAdapter(adapter: CodexAutomationFileAdapter): () => void {
  const previous = fileAdapter;
  const previousCustom = customAdapter;
  fileAdapter = adapter;
  customAdapter = true;
  return () => {
    fileAdapter = previous;
    customAdapter = previousCustom;
  };
}

export function codexAutomationFilesAvailable(): boolean {
  return customAdapter || isTauriRuntime();
}

export async function readCodexAutomationFiles(): Promise<CodexAutomationDefinition[]> {
  const files = await fileAdapter.list();
  return files.map(({ content }) => parseCodexAutomationToml(content));
}

export async function writeCodexAutomationFile(definition: CodexAutomationDefinition): Promise<void> {
  await fileAdapter.write(definition.id, serializeCodexAutomationToml(definition));
}

export async function deleteCodexAutomationFile(id: string): Promise<void> {
  await fileAdapter.remove(id);
}

export function parseCodexAutomationToml(content: string): CodexAutomationDefinition {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(trimmed);
    if (match) values.set(match[1], match[2].trim());
  }

  const required = ['id', 'name', 'prompt', 'status', 'rrule'] as const;
  const missing = required.filter((key) => !values.has(key));
  if (missing.length > 0) throw new Error(`Codex automation.toml 缺少 ${missing.join('、')}`);

  const status = stringValue(values, 'status') as CodexAutomationStatus;
  if (status !== 'ACTIVE' && status !== 'PAUSED') {
    throw new Error(`Codex automation.toml 的 status 无效：${status}`);
  }
  const cwds = values.has('cwds') ? stringArrayValue(values, 'cwds') : [];
  const createdAt = scalarValue(values.get('created_at')) ?? Date.now();
  const updatedAt = scalarValue(values.get('updated_at')) ?? createdAt;
  const version = numberValue(values.get('version'));

  return {
    ...(version == null ? {} : { version }),
    id: stringValue(values, 'id'),
    kind: values.has('kind') ? stringValue(values, 'kind') : 'cron',
    name: stringValue(values, 'name'),
    prompt: stringValue(values, 'prompt'),
    status,
    rrule: stringValue(values, 'rrule'),
    ...(values.has('model') ? { model: stringValue(values, 'model') } : {}),
    ...(values.has('reasoning_effort')
      ? { reasoningEffort: stringValue(values, 'reasoning_effort') }
      : {}),
    executionEnvironment: values.has('execution_environment')
      ? stringValue(values, 'execution_environment')
      : 'local',
    ...(values.has('target') ? { target: values.get('target') } : {}),
    ...(values.has('target_thread_id')
      ? { targetThreadId: stringValue(values, 'target_thread_id') }
      : {}),
    cwds,
    createdAt,
    updatedAt,
  };
}

export function serializeCodexAutomationToml(definition: CodexAutomationDefinition): string {
  const lines = [
    `version = ${definition.version ?? 1}`,
    `id = ${tomlString(definition.id)}`,
    `kind = ${tomlString(definition.kind || 'cron')}`,
    `name = ${tomlString(definition.name)}`,
    `prompt = ${tomlString(definition.prompt)}`,
    `status = ${tomlString(definition.status)}`,
    `rrule = ${tomlString(definition.rrule)}`,
    ...(definition.model ? [`model = ${tomlString(definition.model)}`] : []),
    ...(definition.reasoningEffort
      ? [`reasoning_effort = ${tomlString(definition.reasoningEffort)}`]
      : []),
    ...(definition.kind === 'heartbeat'
      ? definition.targetThreadId
        ? [`target_thread_id = ${tomlString(definition.targetThreadId)}`]
        : []
      : [
          `execution_environment = ${tomlString(definition.executionEnvironment || 'local')}`,
          ...(definition.target ? [`target = ${definition.target}`] : []),
          `cwds = [${definition.cwds.map(tomlString).join(', ')}]`,
        ]),
    `created_at = ${tomlScalar(definition.createdAt)}`,
    `updated_at = ${tomlScalar(definition.updatedAt)}`,
  ];
  return `${lines.join('\n')}\n`;
}

function stringValue(values: ReadonlyMap<string, string>, key: string): string {
  const raw = values.get(key);
  if (!raw) throw new Error(`Codex automation.toml 缺少 ${key}`);
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed;
  } catch {
    // 统一走下面的字段错误。
  }
  throw new Error(`Codex automation.toml 的 ${key} 不是字符串`);
}

function stringArrayValue(values: ReadonlyMap<string, string>, key: string): string[] {
  const raw = values.get(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed;
  } catch {
    // 统一走下面的字段错误。
  }
  throw new Error(`Codex automation.toml 的 ${key} 不是字符串数组`);
}

function scalarValue(raw: string | undefined): number | string | undefined {
  if (!raw) return undefined;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function numberValue(raw: string | undefined): number | undefined {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlScalar(value: number | string): string {
  return typeof value === 'number' ? String(value) : tomlString(value);
}
