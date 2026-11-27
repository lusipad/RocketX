import { useT } from '../i18n';
import type { AcpAgentProfile } from '../platform/desktopCommands';

export default function WorkStartProfile({ profiles, value, onChange }: {
  profiles: AcpAgentProfile[];
  value?: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  if (profiles.length < 2) return profiles.length ? <p className="text-xs text-ink-2">{t('agent.workStartProfile.executorSingle', { name: profiles[0].name })}</p> : null;
  return <label className="work-control-field">{t('agent.workStartProfile.executorLabel')}
    <select value={value ?? ''} onChange={event => onChange(event.target.value)} className="w-full rounded border border-line bg-surface-3 px-2 py-1.5 text-sm text-ink">
      <option value="" disabled>{t('agent.workStartProfile.selectCodex')}</option>
      {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
    </select>
  </label>;
}
