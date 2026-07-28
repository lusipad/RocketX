import { CheckCircle2, CircleAlert, Database, ShieldCheck } from 'lucide-react';
import { codexBrainAvailability } from '../lib/butlerBrain';
import { getServerBase } from '../lib/client';
import { useAuth } from '../stores/auth';

function ConnectionRow({
  title,
  detail,
  healthy,
  permission,
}: {
  title: string;
  detail: string;
  healthy: boolean;
  permission: string;
}) {
  return (
    <article className="butler-connection-row">
      <span className={healthy ? 'text-success' : 'text-warning'} aria-hidden="true">
        {healthy ? <CheckCircle2 size={18} /> : <CircleAlert size={18} />}
      </span>
      <div>
        <h3>{title}</h3>
        <p>{detail}</p>
        <small>{permission}</small>
      </div>
    </article>
  );
}

export default function ButlerConnectionsPanel() {
  const authStatus = useAuth((state) => state.status);
  const user = useAuth((state) => state.user);
  const brain = codexBrainAvailability();

  return (
    <section aria-label="连接与权限" className="butler-settings-surface">
      <div className="butler-section-heading">
        <div>
          <span className="butler-eyebrow">能力边界</span>
          <h2>连接与权限</h2>
          <p>清楚知道管家能看什么、能做到哪一步，以及哪些动作仍需要你确认。</p>
        </div>
        <ShieldCheck size={22} aria-hidden="true" />
      </div>

      <div className="butler-connection-list">
        <ConnectionRow
          title="Rocket.Chat"
          detail={authStatus === 'authed'
            ? `${user?.name || user?.username || '当前账号'} · ${getServerBase()}`
            : '当前没有有效登录会话'}
          healthy={authStatus === 'authed'}
          permission="可读取你有权访问的消息与房间；发送消息仍按动作范围确认。"
        />
        <ConnectionRow
          title="Codex 执行"
          detail={brain.available ? '桌面执行能力可用' : brain.reason || '当前不可用'}
          healthy={brain.available}
          permission="本地修改受工作区和沙箱约束；发布、破坏性动作始终逐次确认。"
        />
        <ConnectionRow
          title="本地责任存储"
          detail="待办、例行照看、管家会话与运行摘要按当前账号隔离"
          healthy
          permission="动态工作事实不会被静默写入长期记忆。"
        />
      </div>

      <div className="butler-permission-note">
        <Database size={16} aria-hidden="true" />
        <p>
          管家默认先读、先整理、先拟稿。只有确实要改变外部世界时，才会把目标、
          范围和后果翻译成人话请你决定。
        </p>
      </div>
    </section>
  );
}
