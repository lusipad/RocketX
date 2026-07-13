import { useEffect, useState } from 'react';
import {
  Bell,
  CheckCircle2,
  Info,
  LayoutGrid,
  Loader2,
  Monitor,
  Moon,
  Palette,
  Server,
  Sun,
  XCircle,
} from 'lucide-react';
import { getServerBase, isTauri } from '../lib/client';
import { loadTheme, saveTheme, type ThemeMode } from '../lib/theme';
import {
  loadWorkbenchConfig,
  saveWorkbenchConfig,
  type WorkbenchConfig,
} from '../lib/ado';
import { useAuth } from '../stores/auth';
import Avatar from '../components/Avatar';

type Section = 'account' | 'appearance' | 'workbench' | 'notification' | 'about';

const SECTIONS: { key: Section; label: string; icon: typeof Server }[] = [
  { key: 'account', label: '账号与服务器', icon: Server },
  { key: 'appearance', label: '外观', icon: Palette },
  { key: 'workbench', label: '工作台', icon: LayoutGrid },
  { key: 'notification', label: '通知', icon: Bell },
  { key: 'about', label: '关于', icon: Info },
];

const THEMES: { key: ThemeMode; label: string; icon: typeof Sun; desc: string }[] = [
  { key: 'light', label: '浅色', icon: Sun, desc: '明亮清爽' },
  { key: 'dark', label: '深色', icon: Moon, desc: '夜间护眼' },
  { key: 'system', label: '跟随系统', icon: Monitor, desc: '自动切换' },
];

/** 外观：主题切换 */
function AppearanceSection() {
  const [theme, setTheme] = useState<ThemeMode>(loadTheme);

  const pick = (mode: ThemeMode) => {
    setTheme(mode);
    saveTheme(mode);
  };

  return (
    <Row label="主题" hint="整体配色会立即切换，选择跟随系统时会随系统的浅色/深色模式自动变化">
      <div className="flex gap-3">
        {THEMES.map(({ key, label, icon: Icon, desc }) => {
          const active = theme === key;
          return (
            <button
              key={key}
              onClick={() => pick(key)}
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

const APP_VERSION = '0.2.1';

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-line py-4 last:border-b-0">
      <div className="mb-1.5 text-sm font-medium text-ink">{label}</div>
      {hint && <div className="mb-2 text-xs leading-relaxed text-ink-3">{hint}</div>}
      {children}
    </div>
  );
}

const inputCls =
  'h-9 w-full max-w-md rounded-md border border-line px-3 text-sm outline-none transition focus:border-primary';

/** 账号与服务器 */
function AccountSection() {
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const server = getServerBase() || location.origin;

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
      <Row label="服务器地址" hint="切换服务器需要重新登录">
        <div className="flex items-center gap-2">
          <input readOnly value={server} className={`${inputCls} bg-fill-2 text-ink-2`} />
        </div>
      </Row>
      <Row label="退出登录" hint="退出后将返回登录页，可切换服务器或账号">
        <button
          onClick={() => void logout()}
          className="h-9 rounded-md border border-danger px-4 text-sm text-danger transition hover:bg-[#feeceb]"
        >
          退出登录
        </button>
      </Row>
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

  const save = () => {
    saveWorkbenchConfig({
      mode: config.mode,
      bridge: config.bridge?.trim().replace(/\/+$/, '') || undefined,
      adoBase: config.adoBase?.trim().replace(/\/+$/, '') || undefined,
      pat: config.pat?.trim() || undefined,
      account: config.account.trim(),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <>
      <Row
        label="连接方式"
        hint={
          isTauri
            ? '桌面客户端建议「直连」：请求经原生通道发出，不受浏览器跨域限制。'
            : '网页端建议「ado-bridge」：浏览器直连 ADO 会被跨域策略拦截（除非 ADO 服务器允许跨域）。'
        }
      >
        <div className="flex max-w-md gap-1 rounded-lg bg-fill-1 p-1">
          {(
            [
              { key: 'direct', label: '直连 Azure DevOps' },
              { key: 'bridge', label: '经 ado-bridge 服务' },
            ] as const
          ).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => update({ mode: key })}
              className={`h-8 flex-1 rounded-md text-xs transition ${
                config.mode === key ? 'bg-surface-4 font-medium text-primary shadow-sm' : 'text-ink-2'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </Row>

      {config.mode === 'direct' ? (
        <>
          <Row
            label="ADO 集合地址"
            hint="Azure DevOps Server 的集合地址，通常形如 http://ado-server:8080/tfs/DefaultCollection"
          >
            <input
              value={config.adoBase ?? ''}
              onChange={(e) => update({ adoBase: e.target.value })}
              placeholder="http://ado-server:8080/tfs/DefaultCollection"
              className={inputCls}
            />
          </Row>
          <Row
            label="个人访问令牌（PAT）"
            hint="在 ADO 的「用户设置 → 个人访问令牌」创建，只读权限即可：Work Items(Read)、Code(Read)、Build(Read)。PAT 仅保存在本机。"
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

      <Row label="我的 ADO 账号" hint="用于筛选「我的工作项」「待我评审」，填邮箱或域账号">
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
          onClick={save}
          disabled={!config.account.trim()}
          className="h-9 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover disabled:opacity-40"
        >
          {saved ? '已保存' : '保存'}
        </button>
      </div>

      {result && (
        <div
          className={`mt-3 flex max-w-2xl items-start gap-2 rounded-lg px-3 py-2.5 text-sm ${
            result.ok ? 'bg-[#e8f7ea] text-success' : 'bg-[#feeceb] text-danger'
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

/** 通知 */
function NotificationSection() {
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied',
  );

  const request = async () => {
    if (typeof Notification === 'undefined') return;
    const p = await Notification.requestPermission();
    setPermission(p);
  };

  const label =
    permission === 'granted' ? '已开启' : permission === 'denied' ? '已被拒绝' : '未开启';

  return (
    <>
      <Row label="桌面通知" hint="非当前会话收到新消息时弹出系统通知（免打扰的会话不会弹）">
        <div className="flex items-center gap-3">
          <span
            className={`rounded px-2 py-1 text-xs ${
              permission === 'granted'
                ? 'bg-[#e8f7ea] text-success'
                : permission === 'denied'
                  ? 'bg-[#feeceb] text-danger'
                  : 'bg-fill-1 text-ink-2'
            }`}
          >
            {label}
          </span>
          {permission === 'default' && (
            <button
              onClick={() => void request()}
              className="h-8 rounded-md bg-primary px-3 text-xs text-white hover:bg-primary-hover"
            >
              开启通知
            </button>
          )}
          {permission === 'denied' && (
            <span className="text-xs text-ink-3">
              请在浏览器/系统设置中恢复本应用的通知权限
            </span>
          )}
        </div>
      </Row>
      <Row label="免打扰" hint="在会话列表右键任意会话 →「消息免打扰」，该会话不再弹通知、角标转灰">
        <span className="text-xs text-ink-3">按会话单独设置</span>
      </Row>
    </>
  );
}

/** 关于 */
function AboutSection() {
  const [rcVersion, setRcVersion] = useState<string>('查询中…');

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

/** 设置模块 */
export default function SettingsPage() {
  const [section, setSection] = useState<Section>('account');

  return (
    <div className="flex min-w-0 flex-1">
      <aside className="w-[200px] shrink-0 border-r border-line bg-fill-2 p-3">
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
          <h1 className="mb-2 text-lg font-semibold text-ink">
            {SECTIONS.find((s) => s.key === section)?.label}
          </h1>
          {section === 'account' && <AccountSection />}
          {section === 'appearance' && <AppearanceSection />}
          {section === 'workbench' && <WorkbenchSection />}
          {section === 'notification' && <NotificationSection />}
          {section === 'about' && <AboutSection />}
        </div>
      </main>
    </div>
  );
}
