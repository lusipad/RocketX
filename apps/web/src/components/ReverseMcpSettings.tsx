import { Check, Copy, Loader2, Unplug, Waypoints } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getServerBase, isTauri, loadStoredAuth } from '../lib/client';
import {
  disableReverseMcp,
  enableReverseMcp,
  readReverseMcpConfig,
  type ReverseMcpConfigStatus,
} from '../platform/desktopCommands';
import { toast } from '../stores/toast';
import { useT } from '../i18n';

type McpStatus = ReverseMcpConfigStatus;

export default function ReverseMcpSettings() {
  const t = useT();
  const [status, setStatus] = useState<McpStatus>({ enabled: false });
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    if (!isTauri) {
      setBusy(false);
      return;
    }
    readReverseMcpConfig()
      .then(setStatus)
      .catch((error) => toast.error(error, t('settings.reverseMcp.readFailed')))
      .finally(() => setBusy(false));
  }, []);

  const config = useMemo(
    () =>
      status.command
        ? JSON.stringify(
            { mcpServers: { rocketx: { command: status.command, args: ['--mcp'] } } },
            null,
            2,
          )
        : '',
    [status.command],
  );

  const toggle = async () => {
    setBusy(true);
    try {
      if (status.enabled) {
        await disableReverseMcp();
        setStatus((current) => ({ ...current, enabled: false, serverUrl: undefined, userId: undefined }));
        toast.success(t('settings.reverseMcp.disabledToast'));
      } else {
        const auth = loadStoredAuth();
        const serverUrl = getServerBase();
        if (!auth || !serverUrl) throw new Error(t('settings.reverseMcp.loginRequired'));
        await enableReverseMcp({
          serverUrl,
          userId: auth.userId,
          authToken: auth.authToken,
        });
        setStatus((current) => ({
          ...current,
          enabled: true,
          serverUrl,
          userId: auth.userId,
        }));
        toast.success(t('settings.reverseMcp.enabledToast'));
      }
    } catch (error) {
      toast.error(error, t('settings.reverseMcp.toggleFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-ink">{t('settings.reverseMcp.heading')}</h2>
      <div className="rounded-lg bg-surface shadow-raise p-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-md bg-primary-light p-2 text-primary">
            <Waypoints size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-ink">{t('settings.reverseMcp.title')}</div>
                <div className="mt-1 text-xs leading-5 text-ink-3">
                  {t('settings.reverseMcp.description')}
                </div>
              </div>
              <button
                onClick={() => void toggle()}
                disabled={!isTauri || busy}
                className={`flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm ${
                  status.enabled
                    ? 'border border-line text-ink-2 hover:bg-fill-hover'
                    : 'bg-primary text-white hover:bg-primary-hover'
                } disabled:opacity-50`}
              >
                {busy ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : status.enabled ? (
                  <Unplug size={14} />
                ) : (
                  <Check size={14} />
                )}
                {status.enabled ? t('settings.reverseMcp.disableAction') : t('settings.reverseMcp.enableAction')}
              </button>
            </div>
            {status.enabled && config ? (
              <div className="mt-3">
                <div className="mb-1 flex items-center justify-between text-xs text-ink-3">
                  <span>{t('settings.reverseMcp.configTitle')}</span>
                  <button
                    onClick={() =>
                      void navigator.clipboard.writeText(config).then(() => toast.success(t('settings.reverseMcp.configCopied')))
                    }
                    className="flex items-center gap-1 hover:text-primary"
                  >
                    <Copy size={12} /> {t('common.copy')}
                  </button>
                </div>
                <pre className="max-h-40 overflow-auto rounded bg-fill-1 p-3 text-xs text-ink-2">{config}</pre>
                <div className="mt-2 text-xs text-ink-3">
                  {t('settings.reverseMcp.credentialNote')}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
