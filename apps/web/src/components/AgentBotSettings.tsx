import { Bot, Loader2, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getServerBase, isTauri } from '../lib/client';
import {
  deleteAgentBotConfig,
  readAgentBotConfig,
  saveAgentBotConfig,
  type AgentBotConfigStatus,
} from '../platform/desktopCommands';
import { toast } from '../stores/toast';
import { useT } from '../i18n';

type BotStatus = AgentBotConfigStatus;

const inputCls =
  'h-9 w-full rounded-md border border-line bg-surface px-3 text-sm outline-none transition focus:border-primary';

export default function AgentBotSettings() {
  const t = useT();
  const [status, setStatus] = useState<BotStatus>({ enabled: false });
  const [userId, setUserId] = useState('');
  const [username, setUsername] = useState('ai');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    if (!isTauri) {
      setBusy(false);
      return;
    }
    readAgentBotConfig()
      .then((value) => {
        setStatus(value);
        setUserId(value.userId ?? '');
        setUsername(value.username ?? 'ai');
      })
      .catch((error) => toast.error(error, t('settings.agentBot.readFailed')))
      .finally(() => setBusy(false));
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      if (!token.trim()) throw new Error(t('settings.agentBot.tokenRequired'));
      await saveAgentBotConfig({
        serverUrl: getServerBase(),
        userId: userId.trim(),
        username: username.trim(),
        authToken: token.trim(),
      });
      setStatus({ enabled: true, serverUrl: getServerBase(), userId: userId.trim(), username: username.trim() });
      setToken('');
      toast.success(t('settings.agentBot.savedToast'));
    } catch (error) {
      toast.error(error, t('settings.agentBot.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await deleteAgentBotConfig();
      setStatus({ enabled: false });
      setToken('');
      toast.success(t('settings.agentBot.deletedToast'));
    } catch (error) {
      toast.error(error, t('settings.agentBot.deleteFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-ink">{t('settings.agentBot.heading')}</h2>
      <div className="rounded-lg bg-surface shadow-raise p-4">
        <div className="flex items-start gap-3">
          <div className="rounded-md bg-primary-light p-2 text-primary"><Bot size={16} /></div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ink">
              {status.enabled
                ? t('settings.agentBot.enabledTitle', { username: status.username ?? '' })
                : t('settings.agentBot.disabledTitle')}
            </div>
            <div className="mt-1 text-xs leading-5 text-ink-3">
              {t('settings.agentBot.description')}
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder={t('settings.agentBot.usernamePlaceholder')}
                className={inputCls}
              />
              <input
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
                placeholder={t('settings.agentBot.userIdPlaceholder')}
                className={inputCls}
              />
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder={
                  status.enabled
                    ? t('settings.agentBot.replaceTokenPlaceholder')
                    : t('settings.agentBot.tokenPlaceholder')
                }
                autoComplete="new-password"
                className={`${inputCls} sm:col-span-2`}
              />
            </div>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => void save()}
                disabled={!isTauri || busy}
                className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm text-white disabled:opacity-50"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Bot size={14} />}
                {status.enabled ? t('settings.agentBot.replaceButton') : t('settings.agentBot.saveButton')}
              </button>
              {status.enabled ? (
                <button
                  onClick={() => void remove()}
                  disabled={busy}
                  className="flex h-8 items-center gap-1.5 rounded-md border border-line px-3 text-sm text-ink-2 disabled:opacity-50"
                >
                  <Trash2 size={14} /> {t('common.delete')}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
