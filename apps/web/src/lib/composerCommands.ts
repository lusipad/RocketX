import type { MessageKey } from '../i18n';

export interface ActiveComposerToken {
  kind: 'file' | 'slash';
  query: string;
  start: number;
  end: number;
}

export interface BuiltinSlashCommand {
  id: string;
  command: string;
  titleKey: MessageKey;
  descKey: MessageKey;
  kind: 'action' | 'prompt';
  template?: string;
}

export interface RankedSlashOption {
  id: string;
  command: string;
  title: string;
  description: string;
  kind: 'action' | 'prompt' | 'skill';
  template?: string;
  titleKey?: MessageKey;
  descKey?: MessageKey;
  category?: string;
  runCount?: number;
}

export const BUILTIN_SLASH_COMMANDS: readonly BuiltinSlashCommand[] = [
  { id: 'plan', command: 'plan', titleKey: 'agent.composer.slash.planTitle', descKey: 'agent.composer.slash.planDesc', kind: 'action' },
  { id: 'pulse', command: 'pulse', titleKey: 'agent.composer.slash.pulseTitle', descKey: 'agent.composer.slash.pulseDesc', kind: 'action' },
  { id: 'dream', command: 'dream', titleKey: 'agent.composer.slash.dreamTitle', descKey: 'agent.composer.slash.dreamDesc', kind: 'action' },
  { id: 'diff', command: 'diff', titleKey: 'agent.composer.slash.diffTitle', descKey: 'agent.composer.slash.diffDesc', kind: 'action' },
  { id: 'checkpoint', command: 'checkpoint', titleKey: 'agent.composer.slash.checkpointTitle', descKey: 'agent.composer.slash.checkpointDesc', kind: 'action' },
  { id: 'terminal', command: 'terminal', titleKey: 'agent.composer.slash.terminalTitle', descKey: 'agent.composer.slash.terminalDesc', kind: 'action' },
  { id: 'worktree', command: 'worktree', titleKey: 'agent.composer.slash.worktreeTitle', descKey: 'agent.composer.slash.worktreeDesc', kind: 'action' },
  { id: 'review', command: 'review', titleKey: 'agent.composer.slash.reviewTitle', descKey: 'agent.composer.slash.reviewDesc', kind: 'prompt', template: 'Review current uncommitted changes and tests carefully, list concrete issues by severity, and propose fixes.' },
  { id: 'commit', command: 'commit', titleKey: 'agent.composer.slash.commitTitle', descKey: 'agent.composer.slash.commitDesc', kind: 'prompt', template: 'Inspect git diff and summarize clean, conventional commit title + body options.' },
  { id: 'compact', command: 'compact', titleKey: 'agent.composer.slash.compactTitle', descKey: 'agent.composer.slash.compactDesc', kind: 'prompt', template: 'Summarize current progress, key decisions, modified files, and remaining next steps concisely.' },
  { id: 'clear', command: 'clear', titleKey: 'agent.composer.slash.clearTitle', descKey: 'agent.composer.slash.clearDesc', kind: 'action' },
];

export function detectComposerTrigger(text: string, cursorPos: number): ActiveComposerToken | null {
  const safeCursor = Math.max(0, Math.min(cursorPos, text.length));
  const before = text.slice(0, safeCursor);

  // Scan backward up to the nearest whitespace or newline
  let tokenStart = safeCursor;
  while (tokenStart > 0 && !/\s/.test(before[tokenStart - 1])) {
    tokenStart -= 1;
  }
  const token = before.slice(tokenStart);
  if (token.startsWith('@')) {
    return {
      kind: 'file',
      query: token.slice(1),
      start: tokenStart,
      end: safeCursor,
    };
  }
  if (token.startsWith('/') && (tokenStart === 0 || before[tokenStart - 1] === '\n')) {
    const query = token.slice(1);
    if (!query.includes('/')) {
      return {
        kind: 'slash',
        query,
        start: tokenStart,
        end: safeCursor,
      };
    }
  }
  return null;
}

export function applyComposerReplacement(
  text: string,
  token: ActiveComposerToken,
  replacement: string,
): { nextText: string; nextCursor: number } {
  const prefix = text.slice(0, token.start);
  const suffix = text.slice(token.end);
  const needsTrailingSpace = suffix.length === 0 || !/^\s/.test(suffix);
  const inserted = needsTrailingSpace ? `${replacement} ` : replacement;
  return {
    nextText: `${prefix}${inserted}${suffix}`,
    nextCursor: prefix.length + inserted.length,
  };
}

export function rankSlashCommands(
  query: string,
  translate: (key: MessageKey) => string,
  customSkills: ReadonlyArray<{
    id: string;
    slug: string;
    name: string;
    description: string;
    promptTemplate: string;
    category?: string;
    runCount?: number;
  }> = [],
): RankedSlashOption[] {
  const q = query.trim().toLowerCase();
  const options: RankedSlashOption[] = [
    ...BUILTIN_SLASH_COMMANDS.map((item) => ({
      id: item.id,
      command: item.command,
      title: translate(item.titleKey),
      description: translate(item.descKey),
      kind: item.kind,
      template: item.template,
      titleKey: item.titleKey,
      descKey: item.descKey,
    })),
    ...customSkills.map((skill) => ({
      id: `skill:${skill.id}`,
      command: skill.slug || skill.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-'),
      title: skill.name,
      description: skill.description,
      kind: 'skill' as const,
      template: skill.promptTemplate,
      category: skill.category,
      runCount: skill.runCount,
    })),
  ];

  if (!q) return options;
  return options
    .map((option) => {
      const cmd = option.command.toLowerCase();
      const title = option.title.toLowerCase();
      let score = 0;
      if (cmd === q) score = 500;
      else if (cmd.startsWith(q)) score = 400;
      else if (cmd.includes(q)) score = 300;
      else if (title.includes(q)) score = 200;
      return { option, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.option.command.localeCompare(b.option.command))
    .map((entry) => entry.option);
}

// Strip CSI / OSC ANSI terminal sequences for clean plain rendering.
const ANSI_ESCAPE_RE = /(?:\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_])/g;

export function stripAnsiSequences(raw: string): string {
  return raw.replace(ANSI_ESCAPE_RE, '').replace(/\r\n/g, '\n');
}
