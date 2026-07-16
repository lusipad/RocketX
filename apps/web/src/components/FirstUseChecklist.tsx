import { useEffect, useState } from 'react';
import { Bell, Check, Circle, MessageCircle, Send, X } from 'lucide-react';
import { notifyPermissionGranted, requestNotifyPermission } from '../lib/notify';
import { checklistComplete } from '../lib/onboarding';
import { useOnboarding } from '../stores/onboarding';

export default function FirstUseChecklist({
  hasActiveConversation,
  onStartConversation,
  onFocusComposer,
}: {
  hasActiveConversation: boolean;
  onStartConversation: () => void;
  onFocusComposer: () => void;
}) {
  const state = useOnboarding((store) => store.state);
  const markChecklist = useOnboarding((store) => store.markChecklist);
  const dismiss = useOnboarding((store) => store.dismissChecklist);
  const [notificationError, setNotificationError] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    void notifyPermissionGranted().then((granted) => {
      if (granted) markChecklist('notificationsEnabled');
    });
  }, [markChecklist]);

  if (hidden || !state || state.checklist.dismissed || checklistComplete(state)) return null;

  const tasks = [
    {
      key: 'startedConversation' as const,
      label: '发起一个会话',
      detail: '搜索同事并打开私聊',
      icon: MessageCircle,
      action: onStartConversation,
      actionLabel: '找同事',
    },
    {
      key: 'sentMessage' as const,
      label: '发送第一条消息',
      detail: hasActiveConversation ? '在当前会话输入并发送' : '请先打开一个会话',
      icon: Send,
      action: hasActiveConversation ? onFocusComposer : onStartConversation,
      actionLabel: hasActiveConversation ? '去发送' : '先找同事',
    },
    {
      key: 'notificationsEnabled' as const,
      label: '开启系统通知',
      detail: notificationError ? '系统未授权，可稍后在设置中重试' : '离开窗口也不会错过消息',
      icon: Bell,
      action: async () => {
        const granted = await requestNotifyPermission().catch(() => false);
        if (granted) markChecklist('notificationsEnabled');
        else setNotificationError(true);
      },
      actionLabel: '开启',
    },
  ];

  return (
    <section className="fixed top-4 right-4 z-40 w-[320px] rounded-xl border border-line bg-surface-4 p-4 shadow-xl">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-ink">开始使用 RocketX</div>
          <div className="mt-0.5 text-xs text-ink-3">完成三个动作，确认消息链路正常</div>
        </div>
        <button
          onClick={() => setHidden(true)}
          title="暂时关闭"
          aria-label="暂时关闭首次使用清单"
          className="flex h-6 w-6 items-center justify-center rounded text-ink-3 hover:bg-fill-hover hover:text-ink"
        >
          <X size={14} />
        </button>
      </header>
      <div className="space-y-1.5">
        {tasks.map(({ key, label, detail, icon: Icon, action, actionLabel }) => {
          const done = state.checklist[key];
          return (
            <div key={key} className="flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-fill-1">
              <span className={done ? 'text-success' : 'text-ink-3'}>
                {done ? <Check size={17} /> : <Circle size={17} />}
              </span>
              <Icon size={15} className={done ? 'text-success' : 'text-primary'} />
              <div className="min-w-0 flex-1">
                <div className={`text-sm ${done ? 'text-ink-3 line-through' : 'text-ink'}`}>{label}</div>
                {!done && <div className="truncate text-xs text-ink-3">{detail}</div>}
              </div>
              {!done && (
                <button
                  onClick={() => void action()}
                  className="shrink-0 text-xs text-primary hover:underline"
                >
                  {actionLabel}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <label className="mt-3 flex cursor-pointer items-center gap-2 border-t border-line pt-3 text-xs text-ink-3 hover:text-ink-2">
        <input
          type="checkbox"
          checked={false}
          onChange={dismiss}
          className="h-3.5 w-3.5 cursor-pointer accent-primary"
        />
        跳过引导，不再提醒
      </label>
    </section>
  );
}
