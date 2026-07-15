import { useEffect, useRef, useState } from 'react';
import {
  Bell,
  Camera,
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
import { notifyPermissionGranted, requestNotifyPermission } from '../lib/notify';
import { loadWorkbenchConfig, type WorkbenchConfig } from '../lib/ado';
import { canUseNtlm, type ProbeStep } from '../lib/adoDirect';
import { useAuth } from '../stores/auth';
import { usePrefs } from '../stores/prefs';
import { useAliases } from '../stores/aliases';
import { useUiPrefs } from '../stores/uiPrefs';
import { useWorkbench } from '../stores/workbench';
import { useWiTemplates } from '../stores/wiTemplates';
import { toast } from '../stores/toast';
import Avatar from '../components/Avatar';
import { ConfirmDialog } from '../components/Dialog';
import { RadioGroup, Row, Slider, Toggle } from '../components/SettingControls';

// 由 vite.config.ts 从 apps/desktop/package.json 注入，见那里的说明
declare const __APP_VERSION__: string;
const APP_VERSION = __APP_VERSION__;

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
  const refreshUser = useAuth((s) => s.refreshUser);
  const bumpAvatar = useAuth((s) => s.bumpAvatar);

  const [status, setStatus] = useState(user?.status ?? 'online');
  const [statusText, setStatusText] = useState('');
  const [saved, setSaved] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);

  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);

  const [name, setName] = useState(user?.name ?? '');
  const [nameBusy, setNameBusy] = useState(false);

  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

  useEffect(() => setName(user?.name ?? ''), [user?.name]);

  const applyStatus = async (next: string, text?: string) => {
    const prev = status;
    setStatus(next);
    try {
      // 只传显式给的 text：切在线状态（按钮）时 text 为 undefined，rest 不发 message 字段，
      // 服务器保留原有状态消息；之前用 `text ?? statusText` 会把空输入框的 '' 发出去，
      // 无声清掉用户写的「开会中」（P1-14）。只有点文案保存按钮才带上 message。
      await rest.setStatus(next, text);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setStatus(prev); // 失败回滚，不再假装成功
      toast.error(err, '状态更新失败');
    }
  };

  const uploadAvatar = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      toast.error(new Error('请选择图片文件'), '请选择图片文件');
      return;
    }
    setAvatarBusy(true);
    try {
      await rest.setAvatar(file, file.name);
      bumpAvatar();
      await refreshUser();
      toast.success('头像已更新');
    } catch (err) {
      toast.error(err, '头像上传失败');
    } finally {
      setAvatarBusy(false);
    }
  };

  const saveName = async () => {
    const next = name.trim();
    if (!next || next === user?.name) return;
    setNameBusy(true);
    try {
      await rest.updateOwnBasicInfo({ name: next });
      await refreshUser();
      toast.success('昵称已更新');
    } catch (err) {
      setName(user?.name ?? '');
      toast.error(err, '昵称修改失败');
    } finally {
      setNameBusy(false);
    }
  };

  const changePassword = async () => {
    setPwError(null);
    if (newPw !== newPw2) {
      setPwError('两次输入的新密码不一致');
      return;
    }
    setPwBusy(true);
    try {
      // 一次请求带齐所有字段：这个接口限流很紧（每分钟一次），拆成多次调用会被 429 挡掉
      await rest.updateOwnBasicInfo({ newPassword: newPw, currentPassword: curPw });
      setCurPw('');
      setNewPw('');
      setNewPw2('');
      toast.success('密码已修改');
    } catch (err) {
      // 服务器的密码强度策略是可配置的，猜不出来 —— 原样透出它的说法
      const raw = err instanceof Error ? err.message : String(err ?? '');
      setPwError(
        /totp/i.test(raw)
          ? '当前密码不正确'
          : /too many requests|rate/i.test(raw)
            ? '操作太频繁，请一分钟后再试'
            : raw || '密码修改失败',
      );
    } finally {
      setPwBusy(false);
    }
  };

  return (
    <>
      <Row label="当前账号" hint="点击头像可以更换">
        <div className="flex items-center gap-3">
          <button
            onClick={() => avatarInputRef.current?.click()}
            disabled={avatarBusy}
            title="更换头像"
            className="group relative shrink-0 overflow-hidden rounded-[10px]"
          >
            <Avatar
              name={user?.name || user?.username || '?'}
              username={user?.username}
              size={44}
            />
            <span className="absolute inset-0 flex items-center justify-center bg-black/45 text-white opacity-0 transition group-hover:opacity-100">
              {avatarBusy ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Camera size={16} />
              )}
            </span>
          </button>
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void uploadAvatar(f);
            }}
          />
          <div>
            <div className="text-sm font-medium text-ink">{user?.name || user?.username}</div>
            <div className="text-xs text-ink-3">@{user?.username}</div>
          </div>
        </div>
      </Row>

      <Row label="昵称" hint={`其他成员看到的名字；用户名 @${user?.username ?? ''} 不会跟着变`}>
        <div className="flex items-center gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void saveName()}
            placeholder={user?.username}
            maxLength={80}
            className={inputCls}
          />
          <button
            onClick={() => void saveName()}
            disabled={nameBusy || !name.trim() || name.trim() === user?.name}
            className="h-9 shrink-0 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {nameBusy ? '保存中…' : '保存'}
          </button>
        </div>
      </Row>

      <Row label="修改密码" hint="改完后当前设备保持登录，其他设备需要重新登录">
        <div className="flex max-w-md flex-col gap-2">
          <input
            type="password"
            value={curPw}
            onChange={(e) => setCurPw(e.target.value)}
            placeholder="当前密码"
            autoComplete="current-password"
            className={inputCls}
          />
          <input
            type="password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            placeholder="新密码"
            autoComplete="new-password"
            className={inputCls}
          />
          <input
            type="password"
            value={newPw2}
            onChange={(e) => setNewPw2(e.target.value)}
            placeholder="再输一遍新密码"
            autoComplete="new-password"
            className={inputCls}
          />
          {pwError && <div className="text-xs text-danger">{pwError}</div>}
          <button
            onClick={() => void changePassword()}
            disabled={pwBusy || !curPw || !newPw || !newPw2}
            className="h-9 w-28 rounded-md bg-primary text-sm text-white transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pwBusy ? '修改中…' : '修改密码'}
          </button>
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
          onClick={() => setConfirmLogout(true)}
          className="h-9 rounded-md border border-danger px-4 text-sm text-danger transition hover:bg-danger/10"
        >
          退出登录
        </button>
      </Row>

      {confirmLogout && (
        <ConfirmDialog
          title="退出登录"
          message="退出后需要重新输入账号密码。未发送的草稿会保留在本机。"
          confirmLabel="退出"
          onConfirm={() => void logout()}
          onClose={() => setConfirmLogout(false)}
        />
      )}
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
              <span className="text-2xs text-ink-3">{desc}</span>
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
  const nameFormat = useAliases((s) => s.nameFormat);
  const setNameFormat = useAliases((s) => s.setNameFormat);

  return (
    <>
      <Row label="显示密度" hint="会话列表每一项的高度与信息量">
        <RadioGroup
          value={prefs.sidebarViewMode}
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
          value={prefs.sidebarSortby}
          onChange={(v) => void update({ sidebarSortby: v })}
          options={[
            { key: 'activity', label: '按活跃时间' },
            { key: 'alphabetical', label: '按名称' },
          ]}
        />
      </Row>

      <Row label="备注名显示" hint="给联系人起了备注后，名字怎么显示（本机设置，不跨设备）">
        <RadioGroup
          value={nameFormat}
          onChange={(v) => setNameFormat(v)}
          options={[
            { key: 'alias', label: '只显示备注名' },
            { key: 'aliasWithReal', label: '备注名（原名）' },
          ]}
        />
      </Row>

      <Row label="按类型分区" hint="把会话分成 收藏 / 团队 / 讨论 / 频道 / 私聊 几个可折叠的分区" inline>
        <Toggle
          checked={prefs.sidebarGroupByType}
          onChange={(v) => void update({ sidebarGroupByType: v })}
        />
      </Row>

      <Row label="收藏单独成区" hint="收藏的会话集中显示在顶部" inline>
        <Toggle
          checked={prefs.sidebarShowFavorites}
          onChange={(v) => void update({ sidebarShowFavorites: v })}
        />
      </Row>

      <Row label="未读单独置顶" hint="有未读的会话集中显示在最上方" inline>
        <Toggle
          checked={prefs.sidebarShowUnread}
          onChange={(v) => void update({ sidebarShowUnread: v })}
        />
      </Row>

      <Row label="显示头像" hint="关闭后会话列表更紧凑" inline>
        <Toggle
          checked={prefs.sidebarDisplayAvatar}
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
  const hoverDelayMs = useUiPrefs((s) => s.hoverDelayMs);
  const setHoverDelayMs = useUiPrefs((s) => s.setHoverDelayMs);

  return (
    <>
      <Row label="悬浮工具栏触发" hint="鼠标在消息上停留多久后弹出表情/回复等快捷按钮（本机设置）">
        <RadioGroup
          value={String(hoverDelayMs)}
          onChange={(v) => setHoverDelayMs(Number(v))}
          options={[
            { key: '500', label: '0.5 秒' },
            { key: '1000', label: '1 秒' },
            { key: '2000', label: '2 秒' },
            { key: '3000', label: '3 秒' },
          ]}
        />
      </Row>

      <Row label="发送方式" hint="决定 Enter 键是发送还是换行">
        <RadioGroup
          value={prefs.sendOnEnter}
          onChange={(v) => void update({ sendOnEnter: v })}
          options={[
            { key: 'normal', label: 'Enter 发送', hint: 'Shift+Enter 换行' },
            { key: 'alternative', label: 'Ctrl+Enter 发送', hint: 'Enter 换行' },
          ]}
        />
      </Row>

      <Row label="自动加载图片" hint="关闭后图片需要点击才加载（省流量）" inline>
        <Toggle
          checked={prefs.autoImageLoad}
          onChange={(v) => void update({ autoImageLoad: v })}
        />
      </Row>

      <Row label="在消息中显示头像" inline>
        <Toggle
          checked={prefs.displayAvatars}
          onChange={(v) => void update({ displayAvatars: v })}
        />
      </Row>

      <Row label="显示表情" hint="关闭后 :emoji: 以文本显示" inline>
        <Toggle checked={prefs.useEmojis} onChange={(v) => void update({ useEmojis: v })} />
      </Row>

      <Row label="话题回复也显示在主会话" hint="开启后线程里的回复会同时出现在消息流中" inline>
        <Toggle
          checked={prefs.showThreadsInMainChannel}
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
  // granted / default(未开启,可申请)。桌面端无法区分 denied,统一按可申请处理
  const [permission, setPermission] = useState<'granted' | 'default'>('default');

  useEffect(() => {
    void notifyPermissionGranted().then((ok) => setPermission(ok ? 'granted' : 'default'));
  }, []);

  return (
    <>
      <Row label="系统通知权限" inline>
        <div className="flex items-center gap-2">
          <span
            className={`rounded px-2 py-1 text-xs ${
              permission === 'granted' ? 'bg-success/15 text-success' : 'bg-fill-1 text-ink-2'
            }`}
          >
            {permission === 'granted' ? '已开启' : '未开启'}
          </span>
          {permission === 'default' && (
            <button
              onClick={() =>
                void requestNotifyPermission().then((ok) =>
                  setPermission(ok ? 'granted' : 'default'),
                )
              }
              className="h-8 rounded-md bg-primary px-3 text-xs text-white hover:bg-primary-hover"
            >
              开启
            </button>
          )}
        </div>
      </Row>

      <Row label="桌面通知" hint="哪些消息会弹出系统通知">
        <RadioGroup
          value={prefs.desktopNotifications}
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
          checked={prefs.muteFocusedConversations}
          onChange={(v) => void update({ muteFocusedConversations: v })}
        />
      </Row>

      <Row label="未读提醒" hint="有未读时在标题栏与图标上提示" inline>
        <Toggle
          checked={prefs.unreadAlert}
          onChange={(v) => void update({ unreadAlert: v })}
        />
      </Row>

      <Row label="自动离开" hint="长时间无操作后自动把状态改为「离开」" inline>
        <Toggle
          checked={prefs.enableAutoAway}
          onChange={(v) => void update({ enableAutoAway: v })}
        />
      </Row>

      {(prefs.enableAutoAway) && (
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

const AUTH_LABELS: Record<string, string> = {
  ntlm: 'Windows 集成认证',
  pat: 'PAT',
  bearer: 'Bearer Token',
  none: '不带凭据',
};

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
  const setWorkbenchConfig = useWorkbench((s) => s.setConfig);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [steps, setSteps] = useState<ProbeStep[]>([]);
  const [saved, setSaved] = useState(false);
  // 其他设置项都是改完即存，只有这里是「填完再保存」（半截的地址存下去没意义），
  // 所以必须显式告诉用户「还没保存」，否则切走就白填了。
  const [dirty, setDirty] = useState(false);

  const update = (patch: Partial<WorkbenchConfig>) => {
    setConfig((c) => ({ ...c, ...patch }));
    setResult(null);
    setSteps([]);
    setSaved(false);
    setDirty(true);
  };

  // 有未保存改动时，关标签页/刷新前拦一下
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  /**
   * 直连模式：自动探测。用户填的地址可以是项目页地址、带或不带 /tfs，
   * 程序逐级向上找集合根，桌面端优先试 Windows 集成认证，再试 PAT / Bearer。
   */
  const test = async () => {
    setTesting(true);
    setResult(null);
    setSteps([]);
    try {
      if (config.mode === 'direct') {
        if (!config.adoBase?.trim()) throw new Error('请填写 ADO 地址');
        const { probeAdo, directGetIdentity } = await import('../lib/adoDirect');
        const found: ProbeStep[] = [];
        const res = await probeAdo(config.adoBase.trim(), config.pat?.trim() ?? '', (s) => {
          found.push(s);
          setSteps([...found]);
        });
        if (res.found) {
          const { adoBase, auth } = res.found;
          // 顺手问服务器「我是谁」：域账号可能是 lus、CORP\lus 或邮箱，
          // 让用户自己猜该填哪个是没道理的
          let account = config.account.trim();
          let who = '';
          if (!account) {
            try {
              const id = await directGetIdentity({ adoBase, pat: config.pat ?? '', auth });
              account = id.account;
              who = id.displayName;
            } catch {
              /* 拿不到就算了，留空也能用（工作项查询会用 @Me 宏） */
            }
          }
          setConfig((c) => ({ ...c, adoBase, auth, account: account || c.account }));
          const authLabel =
            auth === 'ntlm'
              ? 'Windows 集成认证（当前登录用户，无需 PAT）'
              : AUTH_LABELS[auth];
          setResult({
            ok: true,
            msg:
              `连接成功！集合地址：${adoBase}（${authLabel}），` +
              `可见 ${res.found.projects.length} 个项目：${res.found.projects.slice(0, 3).join('、')}。` +
              (account ? `已识别你的账号：${who || account}。` : '') +
              `已自动填入，点「保存」生效。`,
          });
        } else {
          // 「都失败了」是句废话。把「试了哪些认证方式、为什么没试 NTLM」直接说出来 ——
          // 探测全灭最常见的原因就是：既没有 Windows 集成认证，又没填 PAT。
          const tried = [...new Set(found.map((s) => s.auth))];
          const triedLabel = tried.map((a) => AUTH_LABELS[a] ?? a).join('、');
          const hint = !canUseNtlm
            ? '网页版不能用 Windows 集成认证（浏览器的跨域规则不允许携带系统凭据），所以必须填 PAT，或改用 ado-bridge 模式。'
            : !config.pat?.trim()
              ? 'Windows 集成认证被服务器拒绝了。要么当前登录用户在这台 Azure DevOps 上没有权限，要么服务器关掉了 NTLM/Negotiate —— 后一种情况请填一个 PAT。'
              : 'PAT 也没通过，检查它是否过期、或缺少 Work Items / Code / Build 的读取权限。';
          setResult({
            ok: false,
            msg: `探测失败。试过的认证方式：${triedLabel || '（无）'}。${hint}`,
          });
        }
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
          <Row
            label="ADO 地址"
            hint={
              isTauri
                ? '直接把浏览器地址栏里的地址粘进来即可（项目页地址也行）。点「自动探测」会逐级找到正确的集合根，并优先尝试 Windows 集成认证 —— 域内环境通常填完地址就能连上。'
                : '直接把浏览器地址栏里的地址粘进来即可（项目页地址也行）。点「自动探测」会逐级找到正确的集合根，不必自己拼。'
            }
          >
            <input
              value={config.adoBase ?? ''}
              onChange={(e) => update({ adoBase: e.target.value })}
              placeholder="http://ado-server:8080/DefaultCollection/项目名"
              className={inputCls}
            />
          </Row>
          <Row
            label="个人访问令牌（PAT）"
            hint={
              isTauri
                ? '通常留空即可 —— 桌面端默认用 Windows 集成认证，直接拿你当前登录的域账号连，不需要 PAT。只有服务器禁用了集成认证时才需要填（在 ADO 的「用户设置 → 个人访问令牌」创建，勾选 Work Items / Code / Build 只读）。'
                : '网页端必须填 PAT：浏览器的跨域规则不允许携带 Windows 凭据，做不了集成认证。在 ADO 的「用户设置 → 个人访问令牌」创建，勾选 Work Items / Code / Build 只读。仅保存在本机。'
            }
          >
            <input
              type="password"
              value={config.pat ?? ''}
              onChange={(e) => update({ pat: e.target.value })}
              placeholder="粘贴 PAT（没有可留空）"
              className={inputCls}
            />
          </Row>
          {config.auth && (
            <Row label="认证方式" hint="探测得出，通常无需手动改">
              <div className="text-sm text-ink-2">
                {config.auth === 'pat'
                  ? 'PAT（Basic）'
                  : config.auth === 'bearer'
                    ? 'Bearer Token'
                    : 'Windows 集成认证（免凭据）'}
              </div>
            </Row>
          )}
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

      <Row
        label="我的 ADO 账号"
        hint="留空即可 —— 点「自动探测」时会向服务器确认你是谁并自动填入。「我的工作项」用 ADO 的 @Me 宏查询，不依赖这一栏。只有想看别人的工作项时才手动改。"
      >
        <input
          value={config.account}
          onChange={(e) => update({ account: e.target.value })}
          placeholder="自动识别（也可手填 user@corp.com 或 DOMAIN\\user）"
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
          {config.mode === 'direct' ? '自动探测' : '测试连接'}
        </button>
        <button
          onClick={() => {
            // 走 store 而不是直接写 localStorage：工作台在监听它，保存后立刻重新拉数据
            setWorkbenchConfig({
              mode: config.mode,
              bridge: config.bridge?.trim().replace(/\/+$/, '') || undefined,
              adoBase: config.adoBase?.trim().replace(/\/+$/, '') || undefined,
              pat: config.pat?.trim() || undefined,
              auth: config.auth,
              account: config.account.trim(),
            });
            setSaved(true);
            setDirty(false);
            toast.success('工作台配置已保存');
            setTimeout(() => setSaved(false), 2500);
          }}
          // 账号不再是必填：Windows 集成认证下由服务器识别，工作项查询用 @Me 宏。
          // 真正的必填是「连到哪儿」——直连要地址，桥接要桥接服务地址。
          disabled={
            config.mode === 'direct' ? !config.adoBase?.trim() : !config.bridge?.trim()
          }
          className={`h-9 rounded-md px-4 text-sm text-white transition disabled:opacity-40 ${
            dirty ? 'bg-primary hover:bg-primary-hover' : 'bg-primary/70 hover:bg-primary'
          }`}
        >
          {saved ? '已保存' : '保存'}
        </button>
        {dirty && <span className="text-xs text-warning">有未保存的改动</span>}
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

      {/* 探测过程：每一步试了什么地址、什么认证、结果如何 */}
      <TemplateUrlSection />

      {steps.length > 0 && (
        <div className="mt-3 max-w-2xl overflow-hidden rounded-lg border border-line">
          <div className="border-b border-line bg-fill-2 px-3 py-2 text-xs font-medium text-ink-2">
            探测记录（{steps.length} 次尝试）
          </div>
          <div className="max-h-64 overflow-y-auto">
            {steps.map((s, i) => (
              <div
                key={i}
                className="flex items-start gap-2 border-b border-line px-3 py-2 text-xs last:border-b-0"
              >
                {s.ok ? (
                  <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-success" />
                ) : (
                  <XCircle size={13} className="mt-0.5 shrink-0 text-ink-3" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-2xs text-ink-2">{s.url}</div>
                  <div className={`mt-0.5 break-words ${s.ok ? 'text-success' : 'text-ink-3'}`}>
                    {/* 这里以前把 none（不带凭据）也写成「Windows 集成认证」，
                        看日志的人会以为试过集成认证了，其实压根没试 */}
                    {AUTH_LABELS[s.auth] ?? s.auth}：{s.detail}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function TemplateUrlSection() {
  const url = useWiTemplates((s) => s.url);
  const setUrl = useWiTemplates((s) => s.setUrl);
  const templates = useWiTemplates((s) => s.templates);
  const loading = useWiTemplates((s) => s.loading);
  const error = useWiTemplates((s) => s.error);
  const fetchTpl = useWiTemplates((s) => s.fetch);
  const [draft, setDraft] = useState(url);

  return (
    <div className="mt-6 max-w-2xl border-t border-line pt-4">
      <h3 className="text-sm font-semibold text-ink">工作项模板</h3>
      <p className="mt-1 text-xs text-ink-3">
        团队可共享一个模板配置文件（JSON），放在 Git 仓库或任意 URL。留空则使用内置模板。
      </p>
      <div className="mt-2 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="模板 JSON 的 URL（留空使用内置模板）"
          className="h-8 flex-1 rounded-md border border-line bg-surface-4 px-3 text-sm text-ink outline-none focus:border-primary"
        />
        <button
          onClick={() => setUrl(draft.trim())}
          className="h-8 rounded-md bg-primary px-3 text-sm text-white transition hover:bg-primary-hover"
        >
          保存
        </button>
        {url && (
          <button
            onClick={() => void fetchTpl()}
            disabled={loading}
            className="h-8 rounded-md border border-line px-3 text-sm text-ink-2 transition hover:bg-fill-hover disabled:opacity-40"
          >
            {loading ? '拉取中…' : '重新拉取'}
          </button>
        )}
      </div>
      {error && <div className="mt-1 text-xs text-danger">{error}</div>}
      <div className="mt-2 text-xs text-ink-3">
        当前 {templates.length} 个模板：{templates.map((t) => t.name).join('、')}
      </div>
    </div>
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
  const prefsError = usePrefs((s) => s.error);
  const loadPrefs = usePrefs((s) => s.load);

  // 自己负责把偏好拉起来，不指望 MainPage 挂载时那一次。
  // load() 内部有「已加载就直接返回」和「同一时刻只发一个请求」的保护，重复调用不会多打请求。
  useEffect(() => {
    void loadPrefs();
  }, [loadPrefs]);

  const needsPrefs = ['sidebar', 'message', 'notification'].includes(section);

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
          {needsPrefs && (
            <div className="mb-3 text-xs text-ink-3">
              这些设置保存在 Rocket.Chat 服务器，登录任意设备都会生效
            </div>
          )}
          {needsPrefs && prefsError ? (
            // 拉失败要说人话并给重试，不能挂着「加载中…」装死
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <XCircle size={22} className="text-danger" />
              <div className="max-w-sm text-sm break-words text-ink-2">{prefsError}</div>
              <button
                onClick={() => void loadPrefs()}
                className="h-8 rounded-md border border-line px-4 text-sm text-ink transition hover:bg-fill-hover"
              >
                重试
              </button>
            </div>
          ) : needsPrefs && !loaded ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-ink-3">
              <Loader2 size={14} className="animate-spin" />
              加载设置中…
            </div>
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
