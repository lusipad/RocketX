import type { ButlerSurfaceContext } from './butlerContext';
import { useCalendar } from '../stores/calendar';
import { useChat } from '../stores/chat';
import { todayKey, useTodos } from '../stores/todos';
import { useUI, type ModuleKey } from '../stores/ui';
import { useWorkbench } from '../stores/workbench';

function roomName(rid: string): string {
  const chat = useChat.getState();
  return chat.subscriptions[rid]?.fname
    || chat.subscriptions[rid]?.name
    || chat.rooms[rid]?.fname
    || chat.rooms[rid]?.name
    || rid;
}

export function captureButlerSurfaceContext(module: ModuleKey): ButlerSurfaceContext | null {
  if (module === 'butler-view') return null;
  if (module === 'messages') {
    const chat = useChat.getState();
    const rid = chat.activeRid;
    if (!rid) return { kind: 'surface', label: '消息', detail: '当前没有打开会话', sources: [] };
    const label = roomName(rid);
    return {
      kind: 'room',
      label,
      detail: `当前 Rocket.Chat 房间，已加载 ${chat.messages[rid]?.length ?? 0} 条消息`,
      sources: [{ kind: 'room', id: rid, rid, label }],
    };
  }
  if (module === 'todos') {
    const todos = useTodos.getState().todos;
    return {
      kind: 'todos',
      label: '待办',
      detail: `当前有 ${todos.filter((todo) => !todo.done).length} 项未完成待办`,
      sources: [],
    };
  }
  if (module === 'calendar') {
    const today = todayKey();
    const count = useCalendar.getState().events.filter((event) => event.date === today).length;
    return { kind: 'calendar', label: '日历', detail: `今天是 ${today}，有 ${count} 项本地日程`, sources: [] };
  }
  if (module === 'workbench') {
    const workbench = useWorkbench.getState();
    const tab = useUI.getState().workbenchTab;
    const labels: Record<string, string> = {
      overview: '工作台概览', workitems: 'ADO 工作项', prs: 'ADO 拉取请求', builds: 'ADO 构建',
    };
    return {
      kind: 'workbench',
      label: labels[tab] ?? (tab.startsWith('query:') ? 'ADO 收藏查询' : '工作台'),
      detail: `已加载 ${workbench.workItems.length} 个工作项、${workbench.prs.length} 个 PR、${workbench.builds.length} 个构建`,
      sources: [],
    };
  }
  const labels: Record<string, string> = { contacts: '通讯录', settings: '设置', codex: '执行间' };
  return { kind: 'surface', label: labels[module] ?? module, detail: '当前 RocketX 工作面', sources: [] };
}
