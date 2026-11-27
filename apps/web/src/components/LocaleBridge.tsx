import { useEffect } from 'react';
import { applyDocumentLocale, t, useLocale } from '../i18n';
import { syncTrayMenuLabels } from '../lib/tray';

export default function LocaleBridge() {
  const locale = useLocale();

  useEffect(() => {
    applyDocumentLocale(locale);
    void syncTrayMenuLabels(t('tray.show', undefined, locale), t('tray.quit', undefined, locale));
  }, [locale]);

  return null;
}
