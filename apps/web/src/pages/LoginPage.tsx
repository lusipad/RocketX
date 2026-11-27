import { useState, type FormEvent } from 'react';
import { Bot, Building2, Rocket, SquareKanban } from 'lucide-react';
import { useT } from '../i18n';
import { useAuth } from '../stores/auth';
import { useUI } from '../stores/ui';
import { getServerBase, isTauri, setServerBase } from '../lib/client';
import type { LoginFailureDisplay } from '../lib/loginDiagnostic';
import { probeRocketChat, writeLoginDiagnostic } from '../lib/loginDiagnostic';
import {
  loadFirstRunState,
  shouldShowFirstRun,
} from '../lib/firstRun';
import { loadWorkspaceSource } from '../lib/workspaceConfig';
import FirstRunPage from './FirstRunPage';
import LanguageSelector from '../components/LanguageSelector';

export default function LoginPage({ embedded = false }: { embedded?: boolean } = {}) {
  const t = useT();
  const { status, error, login, enterLocalMode } = useAuth();
  const setModule = useUI((s) => s.setModule);
  const setButlerView = useUI((s) => s.setButlerView);
  const [server, setServer] = useState(
    () =>
      getServerBase() ||
      (import.meta.env.VITE_ROCKETCHAT_URL as string | undefined) ||
      (isTauri ? 'http://localhost:3300' : ''),
  );
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [serverError, setServerError] = useState<LoginFailureDisplay | null>(null);
  const [checking, setChecking] = useState(false);
  const [firstRun, setFirstRun] = useState(() => {
    const storage = typeof localStorage === 'undefined' ? undefined : localStorage;
    const firstRunState = loadFirstRunState(storage);
    const workspaceSource = loadWorkspaceSource();
    if (embedded) {
      return firstRunState === 'pending';
    }
    return shouldShowFirstRun({
      desktop: isTauri,
      serverUrl: getServerBase(),
      hasWorkspaceSource: !!workspaceSource,
      state: firstRunState,
    });
  });
  const [editServer, setEditServer] = useState(false);
  const busy = checking || status === 'authing';

  if (firstRun) {
    return (
      <div className={embedded ? 'flex min-w-0 flex-1 flex-col overflow-hidden' : 'h-full'}>
        <FirstRunPage
          onContinue={() => {
            setServer(getServerBase() || (isTauri ? 'http://localhost:3300' : ''));
            setFirstRun(false);
          }}
          onEnterLocal={() => {
            setFirstRun(false);
            if (embedded) {
              setModule('butler-view');
              return;
            }
            void enterLocalMode();
          }}
        />
      </div>
    );
  }

  const workspace = loadWorkspaceSource();
  const teamServer = !!workspace && !!getServerBase() && !editServer;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const trimmed = server.trim();
    if (isTauri && !trimmed) {
      setServerError({
        kind: 'invalid_address',
        stage: 'probe',
        summary: t('auth.login.desktopServerRequired'),
        detail: null,
        diagnostic: 'stage=probe kind=invalid_address detail=missing server base',
      });
      return;
    }
    if (trimmed) {
      try {
        const url = new URL(trimmed);
        if (!url.hostname || !['http:', 'https:'].includes(url.protocol)) throw new Error();
      } catch {
        setServerError({
          kind: 'invalid_address',
          stage: 'probe',
          summary: t('auth.login.invalidServerUrl'),
          detail: null,
          diagnostic: 'stage=probe kind=invalid_address detail=client-side URL validation failed',
        });
        return;
      }
    }
    setServerError(null);
    setServerBase(trimmed);
    setChecking(true);
    try {
      await probeRocketChat(trimmed);
    } catch (err) {
      setServerError(await writeLoginDiagnostic(err, 'probe'));
      setChecking(false);
      return;
    }
    setChecking(false);
    await login(username, password);
  };

  return (
    <div
      className={
        embedded
          ? 'flex min-w-0 flex-1 items-center justify-center overflow-y-auto px-6 py-8'
          : 'flex h-full items-center justify-center'
      }
      style={{ background: 'linear-gradient(160deg,#e8f3ff 0%,#f5f8ff 45%,#ffffff 100%)' }}
    >
      <div className="w-full max-w-[420px] rounded-2xl bg-surface-4 p-9 shadow-[0_8px_36px_rgba(31,35,41,0.1)]">
        <div className="mb-4 flex items-center justify-end gap-2">
          <LanguageSelector variant="compact" />
          {isTauri ? (
            <button
              type="button"
              onClick={() => setFirstRun(true)}
              className="shrink-0 rounded-md border border-line px-2.5 py-1 text-xs text-ink-2 transition hover:bg-fill-hover hover:text-ink"
            >
              {t('auth.login.teamConfig')}
            </button>
          ) : null}
        </div>
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary text-white">
            <Rocket size={24} />
          </div>
          <div className="min-w-0">
            <div className="mb-0.5 text-xs text-primary">
              {embedded ? t('auth.login.embeddedSubtitle') : t('auth.login.connectRocketChat')}
            </div>
            <div className="text-xl font-semibold">RocketChat X</div>
            <div className="text-xs text-ink-3">{t('auth.login.tagline')}</div>
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          {teamServer ? (
            <div className="rounded-lg border border-line bg-fill-1 px-3 py-2.5">
              <div className="flex items-center gap-2 text-sm text-ink-2">
                <Building2 size={14} className="text-primary" />
                <span className="font-medium">{workspace.name || t('auth.workspace.defaultTitle')}</span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-3 text-xs text-ink-3">
                <span className="min-w-0 truncate">{getServerBase()}</span>
                <button
                  type="button"
                  onClick={() => setEditServer(true)}
                  className="shrink-0 text-primary hover:underline"
                >
                  {t('auth.login.changeServer')}
                </button>
              </div>
              {serverError && (
                <div className="mt-1 text-xs text-danger">
                  <div>{serverError.summary}</div>
                  {serverError.detail && <div className="mt-1 text-xs text-danger/80">{serverError.detail}</div>}
                </div>
              )}
            </div>
          ) : (
            <div>
              <label className="mb-1.5 block text-sm text-ink-2">{t('auth.login.serverUrlLabel')}</label>
              <input
                value={server}
                onChange={(e) => setServer(e.target.value)}
                autoComplete="url"
                className="h-10 w-full rounded-md border border-line px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary-light"
                placeholder={isTauri ? 'https://chat.example.com' : t('auth.login.serverUrlWebPlaceholder')}
              />
              {serverError && (
                <div className="mt-1 text-xs text-danger">
                  <div>{serverError.summary}</div>
                  {serverError.detail && <div className="mt-1 text-xs text-danger/80">{serverError.detail}</div>}
                </div>
              )}
            </div>
          )}
          <div>
            <label className="mb-1.5 block text-sm text-ink-2">{t('auth.login.usernameLabel')}</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus={!embedded}
              autoComplete="username"
              className="h-10 w-full rounded-md border border-line px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary-light"
              placeholder={t('auth.login.usernamePlaceholder')}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm text-ink-2">{t('auth.login.passwordLabel')}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="h-10 w-full rounded-md border border-line px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary-light"
              placeholder={t('auth.login.passwordPlaceholder')}
            />
          </div>
          {error && (
            <div className="text-sm text-danger">
              <div>{error.summary}</div>
              {error.detail && <div className="mt-1 text-xs text-danger/80">{error.detail}</div>}
            </div>
          )}
          <button
            type="submit"
            disabled={busy || !username || !password}
            className="h-10 w-full rounded-md bg-primary text-sm font-medium text-white transition hover:bg-primary-hover active:bg-primary-active disabled:cursor-not-allowed disabled:opacity-50"
          >
            {checking ? t('auth.login.checkingServer') : status === 'authing' ? t('auth.login.signingIn') : t('auth.login.submit')}
          </button>
        </form>

        <div className="mt-5 border-t border-line pt-4">
          {embedded ? (
            <>
              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setModule('butler-view')}
                  className="flex h-9 items-center justify-center gap-1.5 rounded-md border border-line bg-surface-2 px-3 text-xs font-medium text-ink-2 transition hover:border-primary/40 hover:bg-fill-hover hover:text-ink"
                >
                  <Bot size={14} className="text-primary" />
                  {t('auth.login.useButler')}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setButlerView('kanban')}
                  className="flex h-9 items-center justify-center gap-1.5 rounded-md border border-line bg-surface-2 px-3 text-xs font-medium text-ink-2 transition hover:border-primary/40 hover:bg-fill-hover hover:text-ink"
                >
                  <SquareKanban size={14} className="text-primary" />
                  {t('auth.login.openKanban')}
                </button>
              </div>
              <div className="mt-2.5 text-center text-xs leading-5 text-ink-3">
                {t('auth.login.embeddedLocalHint')}
              </div>
            </>
          ) : (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void enterLocalMode()}
                className="h-10 w-full rounded-md border border-line bg-surface-2 text-sm font-medium text-ink-2 transition hover:border-primary/40 hover:bg-fill-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t('auth.login.useLocally')}
              </button>
              <div className="mt-2 text-center text-xs text-ink-3">
                {t('auth.login.localHint')}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
