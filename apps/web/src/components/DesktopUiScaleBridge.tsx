import { useEffect } from 'react';
import { applyDesktopUiScale } from '../lib/desktopUiScale';
import { isTauri } from '../lib/http';
import { stepUiScale, type UiScale } from '../lib/uiScale';
import { toast } from '../stores/toast';
import { useUiPrefs } from '../stores/uiPrefs';

type ShortcutAction = 'in' | 'out' | 'reset';

function shortcutAction(event: KeyboardEvent): ShortcutAction | null {
  if ((!event.ctrlKey && !event.metaKey) || event.altKey) return null;
  if (
    event.code === 'Equal' ||
    event.code === 'NumpadAdd' ||
    event.key === '+' ||
    event.key === '='
  ) {
    return 'in';
  }
  if (
    event.code === 'Minus' ||
    event.code === 'NumpadSubtract' ||
    event.key === '-' ||
    event.key === '_'
  ) {
    return 'out';
  }
  if (event.code === 'Digit0' || event.code === 'Numpad0' || event.key === '0') return 'reset';
  return null;
}

function nextScale(current: UiScale, action: ShortcutAction): UiScale {
  return action === 'reset' ? 100 : stepUiScale(current, action);
}

export default function DesktopUiScaleBridge() {
  useEffect(() => {
    if (!isTauri) return;
    let active = true;
    let sequence = applyDesktopUiScale(useUiPrefs.getState().uiScale).catch((error) => {
      if (active) toast.error(error, '界面缩放恢复失败');
    });

    const onKeyDown = (event: KeyboardEvent) => {
      const action = shortcutAction(event);
      if (!action) return;
      event.preventDefault();
      sequence = sequence
        .then(async () => {
          const current = useUiPrefs.getState().uiScale;
          const scale = nextScale(current, action);
          if (scale === current && action !== 'reset') return;
          await applyDesktopUiScale(scale);
          useUiPrefs.getState().setUiScale(scale);
        })
        .catch((error) => {
          if (active) toast.error(error, '界面缩放失败');
        });
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      active = false;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return null;
}
