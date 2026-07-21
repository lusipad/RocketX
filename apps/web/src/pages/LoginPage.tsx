import { useState, type FormEvent } from 'react';
import { Building2, Rocket } from 'lucide-react';
import { useAuth } from '../stores/auth';
import { getServerBase, isTauri, setServerBase } from '../lib/client';
import { loginFailureMessage, probeRocketChat } from '../lib/loginDiagnostic';
import { loadFirstRunState, shouldShowFirstRun } from '../lib/firstRun';
import { loadWorkspaceSource } from '../lib/workspaceConfig';
import FirstRunPage from './FirstRunPage';

export default function LoginPage() {
  const { status, error, login } = useAuth();
  const [server, setServer] = useState(
    () =>
      getServerBase() ||
      (import.meta.env.VITE_ROCKETCHAT_URL as string | undefined) ||
      (isTauri ? 'http://localhost:3300' : ''),
  );
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [serverError, setServerError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [firstRun, setFirstRun] = useState(() =>
    shouldShowFirstRun({
      desktop: isTauri,
      serverUrl: getServerBase(),
      hasWorkspaceSource: !!loadWorkspaceSource(),
      state: loadFirstRunState(typeof localStorage === 'undefined' ? undefined : localStorage),
    }),
  );
  const [editServer, setEditServer] = useState(false);
  const busy = checking || status === 'authing';

  if (firstRun) {
    return (
      <FirstRunPage
        onContinue={() => {
          setServer(getServerBase() || (isTauri ? 'http://localhost:3300' : ''));
          setFirstRun(false);
        }}
      />
    );
  }

  const workspace = loadWorkspaceSource();
  const teamServer = !!workspace && !!getServerBase() && !editServer;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const trimmed = server.trim();
    if (isTauri && !trimmed) {
      setServerError('桌面端必须填写服务器地址');
      return;
    }
    if (trimmed) {
      try {
        const url = new URL(trimmed);
        if (!url.hostname || !['http:', 'https:'].includes(url.protocol)) throw new Error();
      } catch {
        setServerError('服务器地址无效，请填写以 http:// 或 https:// 开头的完整地址');
        return;
      }
    }
    setServerError(null);
    setServerBase(trimmed);
    setChecking(true);
    try {
      await probeRocketChat(trimmed);
    } catch (err) {
      // 分类文案面向用户；原始错误进控制台，排查连接问题时不至于无迹可循
      console.warn('[Login] 服务器探活失败', err);
      setServerError(loginFailureMessage(err));
      setChecking(false);
      return;
    }
    setChecking(false);
    await login(username, password);
  };

  return (
    <div
      className="flex h-full items-center justify-center"
      style={{ background: 'linear-gradient(160deg,#e8f3ff 0%,#f5f8ff 45%,#ffffff 100%)' }}
    >
      <div className="w-[400px] rounded-2xl bg-surface-4 p-10 shadow-[0_8px_36px_rgba(31,35,41,0.1)]">
        <div className="mb-8 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-white">
            <Rocket size={24} />
          </div>
          <div>
            <div className="mb-0.5 text-xs text-primary">连接 Rocket.Chat</div>
            <div className="text-xl font-semibold">RocketChat X</div>
            <div className="text-xs text-ink-3">飞书体验 · Rocket.Chat 内核</div>
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          {teamServer ? (
            <div className="rounded-lg border border-line bg-fill-1 px-3 py-2.5">
              <div className="flex items-center gap-2 text-sm text-ink-2">
                <Building2 size={15} className="text-primary" />
                <span className="font-medium">{workspace.name || '团队工作区'}</span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-3 text-xs text-ink-3">
                <span className="min-w-0 truncate">{getServerBase()}</span>
                <button
                  type="button"
                  onClick={() => setEditServer(true)}
                  className="shrink-0 text-primary hover:underline"
                >
                  更换服务器
                </button>
              </div>
              {serverError && <div className="mt-1 text-xs text-danger">{serverError}</div>}
            </div>
          ) : (
            <div>
              <label className="mb-1.5 block text-sm text-ink-2">服务器地址</label>
              <input
                value={server}
                onChange={(e) => setServer(e.target.value)}
                autoComplete="url"
                className="h-10 w-full rounded-md border border-line px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary-light"
                placeholder={isTauri ? 'https://chat.example.com' : '留空使用当前站点'}
              />
              {serverError && <div className="mt-1 text-xs text-danger">{serverError}</div>}
            </div>
          )}
          <div>
            <label className="mb-1.5 block text-sm text-ink-2">用户名 / 邮箱</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
              className="h-10 w-full rounded-md border border-line px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary-light"
              placeholder="请输入用户名或邮箱"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm text-ink-2">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="h-10 w-full rounded-md border border-line px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary-light"
              placeholder="请输入密码"
            />
          </div>
          {error && <div className="text-sm text-danger">{error}</div>}
          <button
            type="submit"
            disabled={busy || !username || !password}
            className="h-10 w-full rounded-md bg-primary text-sm font-medium text-white transition hover:bg-primary-hover active:bg-primary-active disabled:cursor-not-allowed disabled:opacity-50"
          >
            {checking ? '正在检查服务器…' : status === 'authing' ? '登录中…' : '登录'}
          </button>
        </form>

        <div className="mt-6 text-center text-xs text-ink-3">
          使用你的 Rocket.Chat 账号登录，数据完全兼容
        </div>
      </div>
    </div>
  );
}
