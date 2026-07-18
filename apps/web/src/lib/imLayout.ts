export const DEFAULT_CONVERSATION_WIDTH = 280;
export const MIN_CONVERSATION_WIDTH = 220;
export const MAX_CONVERSATION_WIDTH = 480;
export const DEFAULT_BUTLER_PANEL_WIDTH = 380;
export const MIN_BUTLER_PANEL_WIDTH = 300;
export const MAX_BUTLER_PANEL_WIDTH = 640;

export interface ImLayoutStateV1 {
  version: 1;
  conversationWidth: number;
  butlerPanelWidth: number;
  groupCollapsed: boolean;
}

export function clampConversationWidth(width: number): number {
  return Math.min(MAX_CONVERSATION_WIDTH, Math.max(MIN_CONVERSATION_WIDTH, Math.round(width)));
}

export function clampButlerPanelWidth(width: number): number {
  return Math.min(MAX_BUTLER_PANEL_WIDTH, Math.max(MIN_BUTLER_PANEL_WIDTH, Math.round(width)));
}

export function imLayoutStorageKey(server: string, userId: string): string {
  const normalizedServer = server.trim().replace(/\/+$/, '').toLocaleLowerCase() || 'same-origin';
  return `rcx-im-layout-v1:${encodeURIComponent(normalizedServer)}:${encodeURIComponent(userId)}`;
}

export function parseImLayout(raw: string | null): ImLayoutStateV1 {
  if (!raw) return defaultImLayout();
  try {
    const value = JSON.parse(raw) as Partial<ImLayoutStateV1>;
    if (value.version !== 1) return defaultImLayout();
    return {
      version: 1,
      conversationWidth: clampConversationWidth(
        typeof value.conversationWidth === 'number'
          ? value.conversationWidth
          : DEFAULT_CONVERSATION_WIDTH,
      ),
      butlerPanelWidth: clampButlerPanelWidth(
        typeof value.butlerPanelWidth === 'number'
          ? value.butlerPanelWidth
          : DEFAULT_BUTLER_PANEL_WIDTH,
      ),
      groupCollapsed: value.groupCollapsed === true,
    };
  } catch {
    return defaultImLayout();
  }
}

export function defaultImLayout(): ImLayoutStateV1 {
  return {
    version: 1,
    conversationWidth: DEFAULT_CONVERSATION_WIDTH,
    butlerPanelWidth: DEFAULT_BUTLER_PANEL_WIDTH,
    groupCollapsed: false,
  };
}
