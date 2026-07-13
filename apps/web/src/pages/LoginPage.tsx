import { useState, type FormEvent } from 'react';
import { Rocket } from 'lucide-react';
import { useAuth } from '../stores/auth';
import { getServerBase, isTauri, setServerBase } from '../lib/client';

export default function LoginPage() {
  const { status, error, login } = useAuth();
  const [server, setServer] = useState(
    () => getServerBase() || (isTauri ? 'http://localhost:3300' : ''),
  );
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [serverError, setServerError] = useState<string | null>(null);
  const busy = status === 'authing';

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const trimmed = server.trim();
    if (isTauri && !trimmed) {
      setServerError('桌面端必须填写服务器地址');
      return;
    }
    if (trimmed && !/^https?:\/\//.test(trimmed)) {
      setServerError('服务器地址需以 http:// 或 https:// 开头');
      return;
    }
    setServerError(null);
    setServerBase(trimmed);
    void login(username, password);
  };

  return (
    <div
      className="flex h-full items-center justify-center"
      style={{ background: 'linear-gradient(160deg,#e8f3ff 0%,#f5f8ff 45%,#ffffff 100%)' }}
    >
      <div className="w-[400px] rounded-2xl bg-white p-10 shadow-[0_8px_36px_rgba(31,35,41,0.1)]">
        <div className="mb-8 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-white">
            <Rocket size={24} />
          </div>
          <div>
            <div className="text-xl font-semibold">RocketChat X</div>
            <div className="text-xs text-ink-3">飞书体验 · Rocket.Chat 内核</div>
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
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
            {busy ? '登录中…' : '登录'}
          </button>
        </form>

        <div className="mt-6 text-center text-xs text-ink-3">
          使用你的 Rocket.Chat 账号登录，数据完全兼容
        </div>
      </div>
    </div>
  );
}
