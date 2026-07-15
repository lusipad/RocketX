import { useEffect } from 'react';
import { isTauri } from '../lib/http';
import { useGlobalShortcut } from '../stores/globalShortcut';
import { useUI } from '../stores/ui';

let pendingUnregister: Promise<void> = Promise.resolve();

export default function GlobalShortcutBridge() {
  const enabled = useGlobalShortcut((state) => state.config.enabled);
  const shortcut = useGlobalShortcut((state) => state.config.shortcut);
  const setRuntimeStatus = useGlobalShortcut((state) => state.setRuntimeStatus);

  useEffect(() => {
    const windowsDesktop =
      isTauri && typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
    if (!windowsDesktop) {
      setRuntimeStatus('unsupported');
      return;
    }
    if (!enabled) {
      setRuntimeStatus('disabled');
      return;
    }

    let cancelled = false;
    let registered = false;
    let unregister: ((shortcut: string) => Promise<void>) | null = null;
    setRuntimeStatus('registering');

    void (async () => {
      await pendingUnregister;
      if (cancelled) return;
      try {
        const plugin = await import('@tauri-apps/plugin-global-shortcut');
        if (cancelled) return;
        unregister = plugin.unregister;
        await plugin.register(shortcut, (event) => {
          if (event.state !== 'Pressed') return;
          void (async () => {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('show_main_window');
            useUI.getState().openCommandCenter();
          })();
        });
        registered = true;
        if (cancelled) {
          await plugin.unregister(shortcut).catch(() => {});
          return;
        }
        setRuntimeStatus('registered');
      } catch (error) {
        if (!cancelled) {
          setRuntimeStatus(
            'conflict',
            error instanceof Error ? error.message : String(error ?? '快捷键注册失败'),
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      if (registered && unregister) {
        const release = unregister;
        pendingUnregister = pendingUnregister.then(() => release(shortcut).catch(() => {}));
      }
    };
  }, [enabled, setRuntimeStatus, shortcut]);

  return null;
}
