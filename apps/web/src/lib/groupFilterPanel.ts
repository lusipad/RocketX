/** 右侧面板引起的分组栏临时布局态；不属于用户的持久化偏好。 */
export interface GroupFilterPanelState {
  panelCollapsed: boolean;
}

export type GroupFilterPanelEvent =
  | { type: 'panel-open'; groupCollapsed: boolean }
  | { type: 'panel-close' }
  | { type: 'manual-change' };

export const initialGroupFilterPanelState: GroupFilterPanelState = {
  panelCollapsed: false,
};

/**
 * 仅记录由当前右侧面板触发的临时收起。
 * 用户操作会清除这个标记，关闭面板时才不会覆盖用户的新选择。
 */
export function nextGroupFilterPanelState(
  prev: GroupFilterPanelState,
  event: GroupFilterPanelEvent,
): GroupFilterPanelState {
  switch (event.type) {
    case 'panel-open':
      return event.groupCollapsed ? prev : { panelCollapsed: true };
    case 'panel-close':
    case 'manual-change':
      return prev.panelCollapsed ? initialGroupFilterPanelState : prev;
  }
}
