import type { ButlerSource } from './butlerContext';
import { openExternal } from './client';
import { useChat } from '../stores/chat';
import { useUI } from '../stores/ui';

/**
 * 打开一条来源：站内的跳回原处，ADO 的开外链。
 *
 * 从 ButlerSources 组件提到 lib，好让结论动作条也能复用同一套导航
 * ——组件之间互相 import 会把 React 依赖拖进纯逻辑层。分支顺序保持原样。
 */
export async function openButlerSource(source: ButlerSource): Promise<void> {
  const ui = useUI.getState();
  if (source.kind === 'message' && source.rid && source.mid) {
    ui.setModule('messages');
    await useChat.getState().jumpToMessage(source.mid, source.rid);
    return;
  }
  if (source.kind === 'room' && source.rid) {
    ui.setModule('messages');
    await useChat.getState().openRoom(source.rid);
    return;
  }
  if (source.kind === 'todo') {
    ui.setModule('todos');
    return;
  }
  if (source.kind === 'calendar') {
    ui.setModule('calendar');
    return;
  }
  if (source.webUrl) {
    await openExternal(source.webUrl);
    return;
  }
  if (source.kind === 'work-item') ui.setWorkbenchTab('workitems');
  if (source.kind === 'pull-request') ui.setWorkbenchTab('prs');
  if (source.kind === 'build') ui.setWorkbenchTab('builds');
  ui.setModule('workbench');
}
