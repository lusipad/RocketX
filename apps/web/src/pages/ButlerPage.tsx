import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Clock,
  Coffee,
  GitPullRequest,
  Loader2,
  RefreshCw,
  SquareCheckBig,
  Users,
  Workflow,
} from 'lucide-react';
import { getActiveAlerts, pollNow, type ButlerAlert, type ButlerAlertLevel } from '../lib/butlerPoller';
import { expressAlerts, coffeeGreeting, type StyledAlert } from '../lib/butlerExpression';
import { isWorkItemDone } from '../lib/butlerRules';
import { loadCoffeeConfig, wasCoffeeTimeShownToday } from '../lib/coffeeTime';
import { useTodos, isOverdue, todayKey, dueLabel } from '../stores/todos';
import { useWorkbench } from '../stores/workbench';
import { useChat } from '../stores/chat';
import { useUI } from '../stores/ui';
import { openExternal } from '../lib/client';

// ─── Alert 卡片 ───

const levelMeta: Record<ButlerAlertLevel, { label: string; color: string; icon: typeof Bell }> = {
  immediate: { label: '即时', color: 'text-danger', icon: AlertTriangle },
  coffee: { label: '咖啡', color: 'text-warning', icon: Clock },
  silent: { label: '静默', color: 'text-ink-3', icon: CheckCircle2 },
};

const kindIcons: Record<string, typeof Bell> = {
  'build-failed': Workflow,
  'review-timeout': GitPullRequest,
};

function AlertCard({ alert }: { alert: StyledAlert }) {
  const meta = levelMeta[alert.level];
  const Icon = kindIcons[alert.kind] ?? meta.icon;

  const emphasisCls =
    alert.emphasis === 'emphatic'
      ? 'border-danger/40 bg-danger/5'
      : alert.emphasis === 'muted'
        ? 'border-line/60 bg-surface'
        : 'border-line bg-surface-2';

  return (
    <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${emphasisCls}`}>
      <Icon size={16} className={`mt-0.5 shrink-0 ${alert.emphasis === 'muted' ? 'text-ink-3' : meta.color}`} />
      <div className="min-w-0 flex-1">
        <span className={`text-sm font-medium ${alert.emphasis === 'muted' ? 'text-ink-2' : 'text-ink'}`}>{alert.title}</span>
        {alert.detail && (
          <div className="mt-0.5 text-xs leading-5 text-ink-2">{alert.detail}</div>
        )}
        {alert.suggestion && (
          <div className="mt-1.5 rounded border border-primary/20 bg-primary-light/30 px-2 py-1 text-xs text-ink-2">
            {alert.suggestion}
          </div>
        )}
      </div>
      <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
        alert.level === 'immediate' ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-warning'
      }`}>
        {meta.label}
      </span>
    </div>
  );
}

// ─── 咖啡时间三段 ───

function CoffeeSection({ title, icon: Icon, children, count }: {
  title: string;
  icon: typeof Bell;
  children: React.ReactNode;
  count: number;
}) {
  if (count === 0) return null;
  return (
    <section className="mb-5">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-ink-2">
        <Icon size={14} />
        {title}
        <span className="rounded-full bg-fill-1 px-1.5 py-0.5 text-xs text-ink-3">{count}</span>
      </h3>
      <div className="flex flex-col gap-1.5">{children}</div>
    </section>
  );
}

function MiniCard({ label, detail, color = 'text-ink', onClick }: {
  label: string;
  detail?: string;
  color?: string;
  onClick?: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-2 ${onClick ? 'cursor-pointer hover:bg-fill-hover' : ''}`}
      onClick={onClick}
    >
      <span className={`min-w-0 flex-1 truncate text-sm ${color}`}>{label}</span>
      {detail && <span className="shrink-0 text-xs text-ink-3">{detail}</span>}
    </div>
  );
}

let reqSeq = 0;

export default function ButlerPage() {
  const [alerts, setAlerts] = useState<ButlerAlert[]>([]);
  const [loading, setLoading] = useState(false);

  const todos = useTodos((s) => s.todos);
  const workItems = useWorkbench((s) => s.workItems);
  const prs = useWorkbench((s) => s.prs);
  const openRoom = useChat((s) => s.openRoom);
  const setModule = useUI((s) => s.setModule);

  const today = todayKey();
  const coffeeConfig = loadCoffeeConfig();
  const coffeeShown = wasCoffeeTimeShownToday();

  useEffect(() => {
    void loadAlerts();
  }, []);

  async function loadAlerts() {
    const seq = ++reqSeq;
    setLoading(true);
    try {
      const result = await getActiveAlerts();
      if (seq === reqSeq) setAlerts(result);
    } finally {
      if (seq === reqSeq) setLoading(false);
    }
  }

  async function handleRefresh() {
    const seq = ++reqSeq;
    setLoading(true);
    try {
      const result = await pollNow();
      if (seq === reqSeq) setAlerts(result);
    } finally {
      if (seq === reqSeq) setLoading(false);
    }
  }

  // 表达层：把 raw alert 转成受性格轴影响的 StyledAlert
  const styled = useMemo(() => expressAlerts(alerts), [alerts]);
  const greeting = useMemo(() => coffeeGreeting(), []);

  const immediateAlerts = styled.filter((a) => a.level === 'immediate');
  const coffeeAlerts = styled.filter((a) => a.level === 'coffee');
  const reviewPrs = useMemo(() =>
    prs.filter((pr) => pr.rel === 'review' || pr.rel === 'both'),
  [prs]);

  // ② 我答应/在等什么
  const commitments = useMemo(() =>
    todos.filter((t) => !t.done && (t.committedTo || t.waitingFor)),
  [todos]);

  // ③ 接下来做什么——未完成待办（非承诺类），按优先级排序
  const pendingTodos = useMemo(() =>
    todos
      .filter((t) => !t.done && !t.committedTo && !t.waitingFor)
      .sort((a, b) => (a.priority ?? 4) - (b.priority ?? 4)),
  [todos]);

  // 逾期待办
  const overdueTodos = useMemo(() =>
    todos.filter((t) => isOverdue(t, today)),
  [todos, today]);

  // 未完成工作项
  const incompleteWorkItems = useMemo(() =>
    workItems.filter((wi) => !isWorkItemDone(wi.state)),
  [workItems]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex shrink-0 items-center justify-between border-b border-line px-6 py-4">
        <div className="flex items-center gap-3">
          <Bell size={20} className="text-ink-2" />
          <h1 className="text-lg font-semibold text-ink">管家</h1>
          {coffeeConfig.enabled && coffeeShown && (
            <span className="flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-xs text-warning">
              <Coffee size={12} /> 咖啡时间
            </span>
          )}
        </div>
        <button
          onClick={() => void handleRefresh()}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-fill-hover disabled:opacity-50"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          刷新
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {/* 即时提醒——最高优先级，始终在最上面 */}
        {immediateAlerts.length > 0 && (
          <section className="mb-6">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-danger">
              <AlertTriangle size={14} />
              需要立即关注（{immediateAlerts.length}）
            </h2>
            <div className="flex flex-col gap-2">
              {immediateAlerts.map((a) => <AlertCard key={a.id} alert={a} />)}
            </div>
          </section>
        )}

        {/* 咖啡时间三段式 */}
        <div className="mb-6 rounded-xl border border-line bg-surface-2 p-5">
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-ink">
            <Coffee size={16} className="text-warning" />
            咖啡时间汇总
          </h2>
          {greeting && <p className="mb-4 text-xs text-ink-3">{greeting}</p>}
          {!greeting && <div className="mb-3" />}

          {/* ① 我错过了什么 */}
          <CoffeeSection title="我错过了什么" icon={Bell} count={coffeeAlerts.length + reviewPrs.length}>
            {coffeeAlerts.map((a) => (
              <MiniCard key={a.id} label={a.title} detail={a.detail} color="text-warning" />
            ))}
            {reviewPrs.map((pr) => (
              <MiniCard
                key={pr.id}
                label={`PR #${pr.id} ${pr.title}`}
                detail={pr.repo}
                onClick={() => void openExternal(pr.webUrl)}
              />
            ))}
          </CoffeeSection>

          {/* ② 我答应/在等什么 */}
          <CoffeeSection title="我答应 / 在等什么" icon={Users} count={commitments.length}>
            {commitments.map((t) => (
              <MiniCard
                key={t.id}
                label={t.title || t.note || '待办'}
                detail={[
                  t.committedTo ? `答应 ${t.committedTo}` : `等 ${t.waitingFor}`,
                  t.due ? dueLabel(t.due, today) : '',
                ].filter(Boolean).join(' · ')}
                color={t.due && t.due <= today ? 'text-danger' : 'text-ink'}
                onClick={t.rid ? () => { void openRoom(t.rid!); setModule('messages'); } : undefined}
              />
            ))}
          </CoffeeSection>

          {/* ③ 接下来做什么 */}
          <CoffeeSection title="接下来做什么" icon={SquareCheckBig} count={pendingTodos.length + incompleteWorkItems.length}>
            {overdueTodos.length > 0 && (
              <div className="mb-1 text-xs font-medium text-danger">
                {overdueTodos.length} 项已逾期
              </div>
            )}
            {pendingTodos.slice(0, 8).map((t) => (
              <MiniCard
                key={t.id}
                label={t.title || t.note || '待办'}
                detail={t.due ? dueLabel(t.due, today) : undefined}
                color={isOverdue(t, today) ? 'text-danger' : 'text-ink'}
                onClick={t.rid ? () => { void openRoom(t.rid!); setModule('messages'); } : undefined}
              />
            ))}
            {pendingTodos.length > 8 && (
              <div className="text-xs text-ink-3">还有 {pendingTodos.length - 8} 项…</div>
            )}
            {incompleteWorkItems.slice(0, 5).map((wi) => (
              <MiniCard
                key={wi.id}
                label={`#${wi.id} ${wi.title}`}
                detail={`${wi.type} · ${wi.state}`}
                onClick={() => void openExternal(wi.webUrl)}
              />
            ))}
            {incompleteWorkItems.length > 5 && (
              <div className="text-xs text-ink-3">还有 {incompleteWorkItems.length - 5} 项工作项…</div>
            )}
          </CoffeeSection>

          {coffeeAlerts.length === 0 && commitments.length === 0 && pendingTodos.length === 0 && incompleteWorkItems.length === 0 && reviewPrs.length === 0 && (
            <div className="py-6 text-center text-sm text-ink-3">
              一切安好——没有需要你注意的事项。
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
