import { create } from 'zustand';
import type { RcTeam } from '@rcx/rc-client';

/**
 * 团队管理面板的状态。
 *
 * 单独一个 store：入口分散在房间信息面板、会话列表右键等多处，而那些地方不渲染
 * 面板本身。由挂在应用根部的 `TeamPanelHost` 统一呈现。
 */
interface TeamPanelState {
  open: boolean;
  /** 要管理的团队；缺省时面板里自己选一个 */
  teamId: string | null;
  /** 打开时预填的团队信息，省掉一次额外请求 */
  seed?: RcTeam;
  openWith: (input: { teamId?: string; seed?: RcTeam }) => void;
  close: () => void;
}

export const useTeamPanel = create<TeamPanelState>((set) => ({
  open: false,
  teamId: null,
  seed: undefined,
  openWith: ({ teamId, seed }) => set({ open: true, teamId: teamId ?? null, seed }),
  close: () => set({ open: false, teamId: null, seed: undefined }),
}));

/** 从任何地方打开团队管理面板。 */
export function openTeamPanel(input: { teamId?: string; seed?: RcTeam } = {}): void {
  useTeamPanel.getState().openWith(input);
}
