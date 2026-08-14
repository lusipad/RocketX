export interface DshModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface DshReasoningEffort {
  id: string;
  name: string;
  description?: string;
}

export interface DshModel {
  id: string;
  name: string;
  description?: string;
  reasoning?: {
    efforts: DshReasoningEffort[];
    defaultEffort?: string;
  };
}

export interface DshModelGroup {
  id: string;
  name: string;
  models: DshModel[];
}

export interface DshModelFailure {
  id: string;
  name: string;
  message: string;
}

export interface DshModelDirectory {
  current: DshModelSelection;
  routable: boolean;
  groups: DshModelGroup[];
  failures: DshModelFailure[];
}

export interface DshAgentPreset {
  id: string;
  trust: 'system' | 'user';
  isDefault: boolean;
  name?: string;
  description?: string;
  broken?: string;
}

export interface DshPermissionOption {
  id: string;
  name: string;
  description?: string;
}

export interface DshPermissionSelection {
  currentValue: string;
  options: DshPermissionOption[];
}

export interface DshSettingsNamespace {
  ns: string;
  schema: unknown;
  value: unknown;
  revision: number;
}

export interface DshSettingsDescription {
  writable: boolean;
  namespaces: DshSettingsNamespace[];
}

export interface DshPermissionSettings extends DshPermissionSelection {
  writable: boolean;
  revision: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function titleCase(value: string): string {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toLocaleUpperCase('en-US')}${part.slice(1)}`)
    .join(' ');
}

function schemaNode(schema: Record<string, unknown>, ref: unknown): Record<string, unknown> | null {
  const direct = record(ref);
  if (direct) return direct;
  const refs = record(schema.refs);
  if (!refs || (typeof ref !== 'number' && typeof ref !== 'string')) return null;
  return record(refs[String(ref)]);
}

export function permissionSettings(value: DshSettingsDescription): DshPermissionSettings | null {
  const view = value.namespaces.find((entry) => entry.ns === 'permission');
  if (!view) return null;
  const settings = record(view.value);
  const currentValue = settings?.defaultPreset;
  const schema = record(view.schema);
  if (typeof currentValue !== 'string' || !schema) return null;
  const root = schemaNode(schema, schema.uid);
  const dictionary = record(root?.dict);
  const presetNode = schemaNode(schema, dictionary?.defaultPreset);
  const choices = presetNode?.type === 'union' && Array.isArray(presetNode.list)
    ? presetNode.list
    : presetNode ? [presetNode] : [];
  const options = choices.flatMap((choice): DshPermissionOption[] => {
    const node = schemaNode(schema, choice);
    if (node?.type !== 'const' || typeof node.value !== 'string') return [];
    const meta = record(node.meta);
    return [{
      id: node.value,
      name: typeof meta?.description === 'string' && meta.description
        ? meta.description
        : titleCase(node.value),
    }];
  });
  if (!options.some((option) => option.id === currentValue)) return null;
  return {
    writable: value.writable,
    revision: view.revision,
    currentValue,
    options,
  };
}

export function permissionSelection(value: unknown): DshPermissionSelection | null {
  const selection = record(value);
  if (typeof selection?.currentValue !== 'string' || !Array.isArray(selection.options)) return null;
  const options = selection.options.flatMap((candidate): DshPermissionOption[] => {
    const option = record(candidate);
    if (typeof option?.value !== 'string' || option.value === 'custom' || typeof option.name !== 'string') return [];
    return [{
      id: option.value,
      name: option.name,
      ...(typeof option.description === 'string' ? { description: option.description } : {}),
    }];
  });
  return { currentValue: selection.currentValue, options };
}

export function selectedModel(
  groups: DshModelGroup[],
  selection: DshModelSelection | null,
): DshModel | undefined {
  if (!selection) return undefined;
  return groups.find((group) => group.id === selection.provider)
    ?.models.find((model) => model.id === selection.model);
}
