import { create } from 'zustand';

/**
 * 斜杠命令 GUI 的桥接。
 *
 * runSlash 在 zustand 的 chat store 里，对话框是 React 组件——两者不能直接互相引用。
 * 这里放一个「待打开的命令对话框」：runSlash 解析出动作后写入 pending，
 * MainPage 挂载的 <CommandDialogs /> 读到后渲染对应对话框；对话框执行完动作调 close()。
 *
 * 命令之外的功能入口（NavRail「加入频道」、Composer「命令帮助」等）也走这里，
 * 保证同一个功能只有一份对话框实现。
 */
export type CommandDialog =
  | { kind: 'topic'; rid: string; prefill: string }
  | { kind: 'status'; prefill: string }
  | { kind: 'join'; prefill: string }
  | { kind: 'member'; rid: string; action: 'kick' | 'mute' | 'unmute' | 'ban' | 'unban'; prefill: string }
  | { kind: 'roomPick'; rid: string; mode: 'invite-all-from' | 'invite-all-to' }
  | { kind: 'invite'; rid: string; prefill: string }
  | { kind: 'create'; prefill: string; priv: boolean }
  | { kind: 'dm'; prefill: string; draft: string }
  | { kind: 'archive'; rid: string; archive: boolean }
  | { kind: 'leave'; rid: string }
  | { kind: 'poll'; rid: string; prefill: string }
  | { kind: 'help' };

interface CommandUiState {
  pending: CommandDialog | null;
  open: (pending: CommandDialog) => void;
  close: () => void;
}

export const useCommandUi = create<CommandUiState>((set) => ({
  pending: null,
  open: (pending) => set({ pending }),
  close: () => set({ pending: null }),
}));
