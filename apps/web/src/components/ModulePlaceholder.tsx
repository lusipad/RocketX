import { Calendar, FileText, LayoutGrid, Video } from 'lucide-react';
import type { ModuleKey } from '../stores/ui';

const META: Record<
  Exclude<ModuleKey, 'messages' | 'contacts'>,
  { icon: typeof Calendar; title: string; desc: string }
> = {
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
  workbench: {
    icon: LayoutGrid,
    title: '工作台',
    desc: 'Azure DevOps Server 工作项、流水线与 PR 面板将在这里呈现。事件推送已可通过 ado-bridge 服务接入聊天。',
  },
};

export default function ModulePlaceholder({
  module,
}: {
  module: Exclude<ModuleKey, 'messages' | 'contacts'>;
}) {
  const { icon: Icon, title, desc } = META[module];
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 bg-white">
      <div className="flex h-24 w-24 items-center justify-center rounded-2xl bg-fill-1">
        <Icon size={40} className="text-ink-3" />
      </div>
      <div className="text-lg font-medium text-ink">{title}</div>
      <div className="max-w-sm text-center text-sm leading-relaxed text-ink-3">{desc}</div>
    </main>
  );
}
