/** 待转移的对话行（结构化定义，避免依赖 butler store 造成环） */
export interface TransferLine {
  role: 'user' | 'assistant';
  text: string;
}

/** 托管会话里的一条消息：谁说的、是不是 Codex 的回复 */
export interface AgentTransferMessage {
  text: string;
  author: string;
  assistant: boolean;
}

/**
 * 托管会话消息 → 转移对话行：Codex 回复作 assistant，成员发言作 user
 * 并带上说话人前缀（多人群聊导入后才分得清谁说的）。
 */
export function agentConversationLines(
  messages: readonly AgentTransferMessage[],
): TransferLine[] {
  return messages
    .filter((message) => !!message.text.trim())
    .map((message) =>
      message.assistant
        ? { role: 'assistant' as const, text: message.text }
        : { role: 'user' as const, text: `${message.author}：${message.text}` },
    );
}

/**
 * 把 AI 对话导出成 Codex 外部 Agent 会话导入器认可的 JSONL
 * （externalAgentConfig/import 按导入 Claude Code 历史的规则解析）。
 * 每行一条消息：user 的 content 是字符串，assistant 是文本块数组，
 * uuid 链式串联；📌 标记行与开场白等首个用户消息之前的行不导出。
 */
export function claudeSessionJsonl(
  lines: readonly TransferLine[],
  options: { sessionId: string; cwd: string; now: number },
): string {
  const firstUser = lines.findIndex((item) => item.role === 'user');
  const usable = (firstUser === -1 ? [] : lines.slice(firstUser)).filter(
    (item) => !!item.text.trim() && !item.text.startsWith('📌'),
  );
  if (usable.length === 0) throw new Error('还没有可转移的对话内容');
  const startAt = options.now - usable.length * 1000;
  let parentUuid: string | null = null;
  const rows = usable.map((item, index) => {
    const uuid = crypto.randomUUID();
    const row = JSON.stringify({
      type: item.role,
      uuid,
      parentUuid,
      sessionId: options.sessionId,
      timestamp: new Date(startAt + index * 1000).toISOString(),
      cwd: options.cwd,
      userType: 'external',
      isSidechain: false,
      message:
        item.role === 'user'
          ? { role: 'user', content: item.text }
          : { role: 'assistant', content: [{ type: 'text', text: item.text }] },
    });
    parentUuid = uuid;
    return row;
  });
  return `${rows.join('\n')}\n`;
}
