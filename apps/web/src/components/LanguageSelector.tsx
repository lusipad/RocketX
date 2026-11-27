import { Globe, Languages, Monitor } from 'lucide-react';
import { useI18n, type LocalePreference, type MessageKey } from '../i18n';

const LOCALE_OPTIONS: {
  key: LocalePreference;
  labelKey: MessageKey;
  descKey: MessageKey;
  icon: typeof Monitor;
}[] = [
  { key: 'system', labelKey: 'locale.system', descKey: 'locale.systemDesc', icon: Monitor },
  { key: 'zh-CN', labelKey: 'locale.zhCN', descKey: 'locale.zhCNDesc', icon: Languages },
  { key: 'en-US', labelKey: 'locale.enUS', descKey: 'locale.enUSDesc', icon: Globe },
];

export default function LanguageSelector({
  variant = 'compact',
  className = '',
}: {
  variant?: 'compact' | 'cards';
  className?: string;
}) {
  const { preference, setPreference, t } = useI18n();

  if (variant === 'cards') {
    return (
      <div
        className={`flex flex-wrap gap-3 ${className}`.trim()}
        role="radiogroup"
        aria-label={t('locale.ariaLabel')}
      >
        {LOCALE_OPTIONS.map(({ key, labelKey, descKey, icon: Icon }) => {
          const active = preference === key;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setPreference(key)}
              className={`flex w-32 flex-col items-center gap-2 rounded-2xl border-2 p-4 shadow-raise transition ${
                active
                  ? 'border-primary bg-primary-light/80'
                  : 'border-line bg-surface-3 hover:border-line-strong hover:bg-fill-hover'
              }`}
            >
              <Icon size={22} className={active ? 'text-primary' : 'text-ink-2'} />
              <span className={`text-sm font-medium ${active ? 'text-primary' : 'text-ink'}`}>
                {t(labelKey)}
              </span>
              <span className="text-xs text-ink-3">{t(descKey)}</span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <label
      className={`inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-1 text-xs text-ink-2 transition hover:border-line-strong hover:text-ink ${className}`.trim()}
    >
      <Globe size={13} className="shrink-0 text-ink-3" aria-hidden="true" />
      <select
        value={preference}
        onChange={(event) => setPreference(event.target.value as LocalePreference)}
        aria-label={t('locale.ariaLabel')}
        className="cursor-pointer bg-transparent text-xs text-ink outline-none"
      >
        {LOCALE_OPTIONS.map(({ key, labelKey }) => (
          <option key={key} value={key} className="bg-surface-4 text-ink">
            {t(labelKey)}
          </option>
        ))}
      </select>
    </label>
  );
}
