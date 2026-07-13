import { useEffect, useState } from 'react';
import {
  Bell,
  CheckCircle2,
  Info,
  LayoutGrid,
  Loader2,
  MessageSquare,
  Monitor,
  Moon,
  Palette,
  PanelLeft,
  Server,
  Sun,
  XCircle,
} from 'lucide-react';
import { getServerBase, isTauri, rest } from '../lib/client';
import { loadTheme, saveTheme, type ThemeMode } from '../lib/theme';
import { loadWorkbenchConfig, saveWorkbenchConfig, type WorkbenchConfig } from '../lib/ado';
import { useAuth } from '../stores/auth';
import { usePrefs } from '../stores/prefs';
import Avatar from '../components/Avatar';
import { RadioGroup, Row, Slider, Toggle } from '../components/SettingControls';

const APP_VERSION = '0.2.2';

type Section =
  | 'account'
  | 'appearance'
  | 'sidebar'
  | 'message'
  | 'notification'
  | 'workbench'
  | 'about';

const SECTIONS: { key: Section; label: string; icon: typeof Server }[] = [
  { key: 'account', label: '账号与状态', icon: Server },
  { key: 'appearance', label: '外观', icon: Palette },
  { key: 'sidebar', label: '侧栏', icon: PanelLeft },
  { key: 'message', label: '消息', icon: MessageSquare },
  { key: 'notification', label: '通知', icon: Bell },
  { key: 'workbench', label: '工作台', icon: LayoutGrid },
  { key: 'about', label: '关于', icon: Info },
];

const inputCls =
  'h-9 w-full max-w-md rounded-md border border-line px-3 text-sm outline-none transition focus:border-primary';

const STATUSES = [
  { key: 'online', label: '在线', color: 'bg-success' },
  { key: 'away', label: '离开', color: 'bg-warning' },
  { key: 'busy', label: '忙碌', color: 'bg-danger' },
  { key: 'offline', label: '隐身', color: 'bg-ink-3' },
] as const;

/** 账号与在线状态 */
function AccountSection() {
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const [status, setStatus] = useState(user?.status ?? 'online');
  const [statusText, setStatusText] = useState('');
  const [saved, setSaved] = useState(false);

  const applyStatus = async (next: string, text?: string) => {
    setStatus(next);
    await rest.setStatus(next, text ?? statusText).catch(() => {});
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <>
      <Row label="当前账号">
        <div className="flex items-center gap-3">
          <Avatar name={user?.name || user?.username || '?'} username={user?.username} size={44} />
          <div>
            <div className="text-sm font-medium text-ink">{user?.name || user?.username}</div>
            <div className="text-xs text-ink-3">@{user?.username}</div>
          </div>
        </div>
      </Row>

      <Row label="在线状态" hint="其他成员会看到你的状态">
        <div className="flex flex-wrap gap-2">
          {STATUSES.map(({ key, label, color }) => {
            const active = status === key;
            return (
              <button
                key={key}
                onClick={() => void applyStatus(key)}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${
                  active
                    ? 'border-primary bg-primary-light font-medium text-primary'
                    : 'border-line text-ink hover:bg-fill-hover'
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${color}`} />
                {label}
              </button>
            );
          })}
        </div>
      </Row>

      <Row label="状态消息" hint="显示在你的名字旁，例如「开会中」「远程办公」">
        <div className="flex items-center gap-2">
          <input
            value={statusText}
            onChange={(e) => setStatusText(e.target.value)}
            placeholder="想说点什么…"
            maxLength={120}
            className={inputCls}
          />
          <button
            onClick={() => void applyStatus(status, statusText)}
            className="h-9 shrink-0 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover"
          >
            {saved ? '已保存' : '保存'}
          </button>
        </div>
      </Row>

      <Row label="服务器地址" hint="切换服务器需要重新登录">
        <input readOnly value={getServerBase() || location.origin} className={`${inputCls} bg-fill-2 text-ink-2`} />
      </Row>

      <Row label="退出登录" hint="退出后返回登录页，可切换服务器或账号">
        <button
          onClick={() => void logout()}
          className="h-9 rounded-md border border-danger px-4 text-sm text-danger transition hover:bg-danger/10"
        >
          退出登录
        </button>
      </Row>
    </>
  );
}

const THEMES: { key: ThemeMode; label: string; icon: typeof Sun; desc: string }[] = [
  { key: 'light', label: '浅色', icon: Sun, desc: '明亮清爽' },
  { key: 'dark', label: '深色', icon: Moon, desc: '夜间护眼' },
  { key: 'system', label: '跟随系统', icon: Monitor, desc: '自动切换' },
];

/** 外观：主题 */
function AppearanceSection() {
  const [theme, setTheme] = useState<ThemeMode>(loadTheme);

  return (
    <Row label="主题" hint="整体配色立即切换；「跟随系统」会随系统的浅色/深色模式变化">
      <div className="flex gap-3">
        {THEMES.map(({ key, label, icon: Icon, desc }) => {
          const active = theme === key;
          return (
            <button
              key={key}
              onClick={() => {
                setTheme(key);
                saveTheme(key);
              }}
              className={`flex w-32 flex-col items-center gap-2 rounded-xl border-2 p-4 transition ${
                active
                  ? 'border-primary bg-primary-light'
                  : 'border-line hover:border-ink-3 hover:bg-fill-hover'
              }`}
            >
              <Icon size={22} className={active ? 'text-primary' : 'text-ink-2'} />
              <span className={`text-sm font-medium ${active ? 'text-primary' : 'text-ink'}`}>
                {label}
              </span>
              <span className="text-[11px] text-ink-3">{desc}</span>
            </button>
          );
        })}
      </div>
    </Row>
  );
}

/** 侧栏偏好（服务端同步，跨设备生效） */
function SidebarSection() {
  const prefs = usePrefs((s) => s.prefs);
  const update = usePrefs((s) => s.update);

  return (
    <>
      <Row label="显示密度" hint="会话列表每一项的高度与信息量">
        <RadioGroup
          value={prefs.sidebarViewMode ?? 'medium'}
          onChange={(v) => void update({ sidebarViewMode: v })}
          options={[
            { key: 'extended', label: '宽松', hint: '显示消息预览' },
            { key: 'medium', label: '标准', hint: '默认' },
            { key: 'condensed', label: '紧凑', hint: '一屏更多会话' },
          ]}
        />
      </Row>

      <Row label="排序方式">
        <RadioGroup
          value={prefs.sidebarSortby ?? 'activity'}
          onChange={(v) => void update({ sidebarSortby: v })}
          options={[
            { key: 'activity', label: '按活跃时间' },
            { key: 'alphabetical', label: '按名称' },
          ]}
        />
      </Row>

      <Row label="按类型分区" hint="把会话分成 收藏 / 团队 / 讨论 / 频道 / 私聊 几个可折叠的分区" inline>
        <Toggle
          checked={prefs.sidebarGroupByType ?? true}
          onChange={(v) => void update({ sidebarGroupByType: v })}
        />
      </Row>

      <Row label="收藏单独成区" hint="收藏的会话集中显示在顶部" inline>
        <Toggle
          checked={prefs.sidebarShowFavorites ?? true}
          onChange={(v) => void update({ sidebarShowFavorites: v })}
        />
      </Row>

      <Row label="未读单独置顶" hint="有未读的会话集中显示在最上方" inline>
        <Toggle
          checked={prefs.sidebarShowUnread ?? false}
          onChange={(v) => void update({ sidebarShowUnread: v })}
        />
      </Row>

      <Row label="显示头像" hint="关闭后会话列表更紧凑" inline>
        <Toggle
          checked={prefs.sidebarDisplayAvatar ?? true}
          onChange={(v) => void update({ sidebarDisplayAvatar: v })}
        />
      </Row>
    </>
  );
}

/** 消息偏好 */
function MessageSection() {
  const prefs = usePrefs((s) => s.prefs);
  const update = usePrefs((s) => s.update);

  return (
    <>
      <Row label="发送方式" hint="决定 Enter 键是发送还是换行">
        <RadioGroup
          value={prefs.sendOnEnter ?? 'normal'}
          onChange={(v) => void update({ sendOnEnter: v })}
          options={[
            { key: 'normal', label: 'Enter 发送', hint: 'Shift+Enter 换行' },
            { key: 'alternative', label: 'Ctrl+Enter 发送', hint: 'Enter 换行' },
          ]}
        />
      </Row>

      <Row label="自动加载图片" hint="关闭后图片需要点击才加载（省流量）" inline>
        <Toggle
          checked={prefs.autoImageLoad ?? true}
          onChange={(v) => void update({ autoImageLoad: v })}
        />
      </Row>

      <Row label="在消息中显示头像" inline>
        <Toggle
          checked={prefs.displayAvatars ?? true}
          onChange={(v) => void update({ displayAvatars: v })}
        />
      </Row>

      <Row label="显示表情" hint="关闭后 :emoji: 以文本显示" inline>
        <Toggle checked={prefs.useEmojis ?? true} onChange={(v) => void update({ useEmojis: v })} />
      </Row>

      <Row label="话题回复也显示在主会话" hint="开启后线程里的回复会同时出现在消息流中" inline>
        <Toggle
          checked={prefs.showThreadsInMainChannel ?? false}
          onChange={(v) => void update({ showThreadsInMainChannel: v })}
        />
      </Row>
    </>
  );
}

/** 通知偏好 */
function NotificationSection() {
  const prefs = usePrefs((s) => s.prefs);
  const update = usePrefs((s) => s.update);
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied',
  );

  return (
    <>
      <Row label="系统通知权限" inline>
        <div className="flex items-center gap-2">
          <span
            className={`rounded px-2 py-1 text-xs ${
              permission === 'granted'
                ? 'bg-success/15 text-success'
                : permission === 'denied'
                  ? 'bg-danger/15 text-danger'
                  : 'bg-fill-1 text-ink-2'
            }`}
          >
            {permission === 'granted' ? '已开启' : permission === 'denied' ? '已拒绝' : '未开启'}
          </span>
          {permission === 'default' && (
            <button
              onClick={() => void Notification.requestPermission().then(setPermission)}
              className="h-8 rounded-md bg-primary px-3 text-xs text-white hover:bg-primary-hover"
            >
              开启
            </button>
          )}
        </div>
      </Row>

      <Row label="桌面通知" hint="哪些消息会弹出系统通知">
        <RadioGroup
          value={prefs.desktopNotifications ?? 'all'}
          onChange={(v) => void update({ desktopNotifications: v })}
          options={[
            { key: 'all', label: '全部消息' },
            { key: 'mentions', label: '仅 @我' },
            { key: 'nothing', label: '不通知' },
          ]}
        />
      </Row>

      <Row label="提示音音量">
        <Slider
          value={prefs.notificationsSoundVolume ?? 100}
          onChange={(v) => void update({ notificationsSoundVolume: v })}
          suffix="%"
        />
      </Row>

      <Row label="当前会话不打扰" hint="正在看的会话收到消息时不弹通知" inline>
        <Toggle
          checked={prefs.muteFocusedConversations ?? true}
          onChange={(v) => void update({ muteFocusedConversations: v })}
        />
      </Row>

      <Row label="未读提醒" hint="有未读时在标题栏与图标上提示" inline>
        <Toggle
          checked={prefs.unreadAlert ?? true}
          onChange={(v) => void update({ unreadAlert: v })}
        />
      </Row>

      <Row label="自动离开" hint="长时间无操作后自动把状态改为「离开」" inline>
        <Toggle
          checked={prefs.enableAutoAway ?? true}
          onChange={(v) => void update({ enableAutoAway: v })}
        />
      </Row>

      {(prefs.enableAutoAway ?? true) && (
        <Row label="无操作多久后离开">
          <Slider
            value={Math.round((prefs.idleTimeLimit ?? 300) / 60)}
            onChange={(v) => void update({ idleTimeLimit: v * 60 })}
            min={1}
            max={60}
            suffix=" 分钟"
          />
        </Row>
      )}
    </>
  );
}

/** 工作台（Azure DevOps） */
function WorkbenchSection() {
  const [config, setConfig] = useState<WorkbenchConfig>(
    () =>
      loadWorkbenchConfig() ?? {
        mode: isTauri ? 'direct' : 'bridge',
        bridge: 'http://localhost:8377',
        adoBase: '',
        pat: '',
        account: '',
      },
  );
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [saved, setSaved] = useState(false);

  const update = (patch: Partial<WorkbenchConfig>) => {
    setConfig((c) => ({ ...c, ...patch }));
    setResult(null);
    setSaved(false);
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      if (config.mode === 'direct') {
        if (!config.adoBase?.trim() || !config.pat?.trim()) {
          throw new Error('请填写 ADO 集合地址与 PAT');
        }
        const { directTestConnection } = await import('../lib/adoDirect');
        const msg = await directTestConnection({
          adoBase: config.adoBase.trim(),
          pat: config.pat.trim(),
        });
        setResult({ ok: true, msg });
      } else {
        const res = await fetch(`${config.bridge}/api/ado/config`);
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `桥接服务返回 ${res.status}`);
        }
        const data = (await res.json()) as { webBase: string };
        setResult({ ok: true, msg: `桥接服务正常，ADO 地址：${data.webBase}` });
      }
    } catch (err) {
      setResult({ ok: false, msg: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <Row
        label="连接方式"
        hint={
          isTauri
            ? '桌面客户端建议「直连」：请求经原生通道发出，不受浏览器跨域限制。'
            : '网页端建议「ado-bridge」：浏览器直连 ADO 会被跨域策略拦截。'
        }
      >
        <RadioGroup
          value={config.mode}
          onChange={(v) => update({ mode: v })}
          options={[
            { key: 'direct', label: '直连 Azure DevOps' },
            { key: 'bridge', label: '经 ado-bridge 服务' },
          ]}
        />
      </Row>

      {config.mode === 'direct' ? (
        <>
          <Row label="ADO 集合地址" hint="通常形如 http://ado-server:8080/tfs/DefaultCollection">
            <input
              value={config.adoBase ?? ''}
              onChange={(e) => update({ adoBase: e.target.value })}
              placeholder="http://ado-server:8080/tfs/DefaultCollection"
              className={inputCls}
            />
          </Row>
          <Row
            label="个人访问令牌（PAT）"
            hint="在 ADO 的「用户设置 → 个人访问令牌」创建，只读即可：Work Items / Code / Build。PAT 仅保存在本机。"
          >
            <input
              type="password"
              value={config.pat ?? ''}
              onChange={(e) => update({ pat: e.target.value })}
              placeholder="粘贴 PAT"
              className={inputCls}
            />
          </Row>
        </>
      ) : (
        <Row label="桥接服务地址" hint="ado-bridge 服务的地址，PAT 保存在服务端">
          <input
            value={config.bridge ?? ''}
            onChange={(e) => update({ bridge: e.target.value })}
            placeholder="http://localhost:8377"
            className={inputCls}
          />
        </Row>
      )}

      <Row label="我的 ADO 账号" hint="用于筛选「我的工作项」「待我评审」">
        <input
          value={config.account}
          onChange={(e) => update({ account: e.target.value })}
          placeholder="user@example.com 或 DOMAIN\\user"
          className={inputCls}
        />
      </Row>

      <div className="flex items-center gap-2 pt-4">
        <button
          onClick={() => void test()}
          disabled={testing}
          className="flex h-9 items-center gap-2 rounded-md border border-line px-4 text-sm text-ink-2 transition hover:bg-fill-hover disabled:opacity-50"
        >
          {testing && <Loader2 size={14} className="animate-spin" />}
          测试连接
        </button>
        <button
          onClick={() => {
            saveWorkbenchConfig({
              mode: config.mode,
              bridge: config.bridge?.trim().replace(/\/+$/, '') || undefined,
              adoBase: config.adoBase?.trim().replace(/\/+$/, '') || undefined,
              pat: config.pat?.trim() || undefined,
              account: config.account.trim(),
            });
            setSaved(true);
            setTimeout(() => setSaved(false), 2500);
          }}
          disabled={!config.account.trim()}
          className="h-9 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover disabled:opacity-40"
        >
          {saved ? '已保存' : '保存'}
        </button>
      </div>

      {result && (
        <div
          className={`mt-3 flex max-w-2xl items-start gap-2 rounded-lg px-3 py-2.5 text-sm ${
            result.ok ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger'
          }`}
        >
          {result.ok ? (
            <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
          ) : (
            <XCircle size={16} className="mt-0.5 shrink-0" />
          )}
          <span className="leading-relaxed break-words">{result.msg}</span>
        </div>
      )}
    </>
  );
}

function AboutSection() {
  const [rcVersion, setRcVersion] = useState('查询中…');

  useEffect(() => {
    fetch(`${getServerBase()}/api/info`)
      .then((r) => r.json())
      .then((d: { version?: string; info?: { version?: string } }) =>
        setRcVersion(d.version ?? d.info?.version ?? '未知'),
      )
      .catch(() => setRcVersion('无法获取'));
  }, []);

  return (
    <>
      <Row label="RocketX">
        <div className="text-sm text-ink-2">
          版本 {APP_VERSION} · {isTauri ? '桌面客户端' : '网页版'}
        </div>
        <div className="mt-1 text-xs text-ink-3">飞书体验的 Rocket.Chat 客户端</div>
      </Row>
      <Row label="Rocket.Chat 服务器">
        <div className="text-sm text-ink-2">
          {getServerBase() || location.origin} · 版本 {rcVersion}
        </div>
      </Row>
      <Row label="项目地址">
        <a
          href="https://github.com/lusipad/RocketX"
          target="_blank"
          rel="noreferrer"
          className="text-sm text-primary hover:underline"
        >
          github.com/lusipad/RocketX
        </a>
      </Row>
    </>
  );
}

export default function SettingsPage() {
  const [section, setSection] = useState<Section>('account');
  const loaded = usePrefs((s) => s.loaded);

  return (
    <div className="flex min-w-0 flex-1">
      <aside className="w-[200px] shrink-0 border-r border-line bg-surface-2 p-3">
        <div className="px-2 py-1.5 text-[15px] font-semibold text-ink">设置</div>
        {SECTIONS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setSection(key)}
            className={`mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition ${
              section === key ? 'bg-primary-light text-primary' : 'text-ink-2 hover:bg-fill-hover'
            }`}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto bg-surface-3">
        <div className="mx-auto max-w-3xl px-8 py-6">
          <h1 className="mb-1 text-lg font-semibold text-ink">
            {SECTIONS.find((s) => s.key === section)?.label}
          </h1>
          {['sidebar', 'message', 'notification'].includes(section) && (
            <div className="mb-3 text-xs text-ink-3">
              这些设置保存在 Rocket.Chat 服务器，登录任意设备都会生效
            </div>
          )}
          {!loaded && ['sidebar', 'message', 'notification'].includes(section) ? (
            <div className="py-10 text-center text-sm text-ink-3">加载设置中…</div>
          ) : (
            <>
              {section === 'account' && <AccountSection />}
              {section === 'appearance' && <AppearanceSection />}
              {section === 'sidebar' && <SidebarSection />}
              {section === 'message' && <MessageSection />}
              {section === 'notification' && <NotificationSection />}
              {section === 'workbench' && <WorkbenchSection />}
              {section === 'about' && <AboutSection />}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
