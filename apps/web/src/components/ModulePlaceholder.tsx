import { Calendar, FileText, Video } from 'lucide-react';
import type { ModuleKey } from '../stores/ui';

/** 仅用于尚未实现的模块（messages/contacts/workbench/settings 有各自页面） */
export type PlaceholderModule = Exclude<
  ModuleKey,
  'messages' | 'todos' | 'contacts' | 'workbench' | 'settings'
>;

const META: Record<PlaceholderModule, { icon: typeof Calendar; title: string; desc: string }> = {
  calendar: {
    icon: Calendar,
    title: '日历',
    desc: '日程管理与会议邀约，规划于后续里程碑。',
  },
  docs: {
    icon: FileText,
    title: '云文档',
    desc: '协同文档与知识库，规划于后续里程碑。',
  },
  meetings: {
    icon: Video,
    title: '视频会议',
    desc: '将基于 Rocket.Chat 会议能力（Jitsi/Pexip）集成。',
  },
};

export default function ModulePlaceholder({ module }: { module: PlaceholderModule }) {
  const { icon: Icon, title, desc } = META[module];
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 bg-surface-3">
      <div className="flex h-24 w-24 items-center justify-center rounded-2xl bg-fill-1">
        <Icon size={40} className="text-ink-3" />
      </div>
      <div className="text-lg font-medium text-ink">{title}</div>
      <div className="max-w-sm text-center text-sm leading-relaxed text-ink-3">{desc}</div>
    </main>
  );
}
