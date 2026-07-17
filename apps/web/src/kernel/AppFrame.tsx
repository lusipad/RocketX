import { useEffect } from 'react';
import { Blocks } from 'lucide-react';
import { appManager } from './installed';
import IframeSandbox from './sandbox/iframe';
import { bridgeHost } from './runtime';

export function AppModule({ appId }: { appId: string }) {
  const app = appManager().get(appId);
  useEffect(() => {
    if (app?.enabled && app.manifest.runtime === 'iframe') bridgeHost.emit(appId, 'app.activated');
  }, [app?.enabled, app?.manifest.runtime, appId]);
  if (!app || !app.enabled) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center text-sm text-ink-3">
        应用已停用或卸载
      </div>
    );
  }
  if (app.manifest.runtime !== 'iframe') {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center text-sm text-ink-3">
        这个应用没有可显示的界面
      </div>
    );
  }
  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface-3">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4 text-sm font-medium text-ink">
        <Blocks size={16} className="text-primary" />
        {app.manifest.name}
      </div>
      <div className="min-h-0 flex-1">
        <IframeSandbox
          appId={appId}
          manifest={app.manifest}
          html={app.entryContent}
          bridge={bridgeHost}
        />
      </div>
    </main>
  );
}

export function AppPanel({ appId }: { appId: string }) {
  const app = appManager().get(appId);
  if (!app || app.manifest.runtime !== 'iframe') return null;
  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-line bg-surface-3">
      <div className="h-11 shrink-0 border-b border-line px-3 py-3 text-sm font-medium text-ink">
        {app.manifest.name}
      </div>
      <div className="min-h-0 flex-1">
        <IframeSandbox
          appId={appId}
          manifest={app.manifest}
          html={app.entryContent}
          bridge={bridgeHost}
        />
      </div>
    </aside>
  );
}
