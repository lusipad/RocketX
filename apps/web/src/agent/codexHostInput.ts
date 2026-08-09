export interface CodexHostInput {
  id: string;
  method: 'item/tool/requestUserInput' | 'mcpServer/elicitation/request';
  policy: 'host-input';
  params: unknown;
  at: number;
}
