import { useState } from 'react';
import { useT } from '../i18n';
import type { LocalAgentEnvironment } from '../stores/agentEnvironments';
import Dialog from './Dialog';

const inputCls =
  'h-9 w-full rounded-md border border-line bg-surface px-3 text-sm outline-none transition focus:border-primary';

export interface ButlerProjectConfigPatch {
  name: string;
  enabled: boolean;
  adoProjects: string[];
  defaultBaseBranch: string;
  branchPrefix: string;
}

export default function ButlerProjectConfigDialog({
  path,
  environment,
  busy,
  onClose,
  onSave,
}: {
  path: string;
  environment?: LocalAgentEnvironment;
  busy: boolean;
  onClose: () => void;
  onSave: (patch: ButlerProjectConfigPatch) => void;
}) {
  const t = useT();
  const [name, setName] = useState(environment?.name ?? path.split(/[\\/]/).filter(Boolean).at(-1) ?? t('butler.projectConfig.defaultName'));
  const [enabled, setEnabled] = useState(environment?.enabled ?? true);
  const [adoProjects, setAdoProjects] = useState(environment?.adoProjects.join(', ') ?? '');
  const [defaultBaseBranch, setDefaultBaseBranch] = useState(environment?.defaultBaseBranch ?? 'main');
  const [branchPrefix, setBranchPrefix] = useState(environment?.branchPrefix ?? 'ai/');

  return (
    <Dialog
      title={t('butler.projectConfig.title')}
      hint={environment
        ? t('butler.projectConfig.hintExisting')
        : t('butler.projectConfig.hintNew')}
      width={520}
      onClose={onClose}
      footer={(
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-md border border-line px-4 text-sm text-ink-2"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => onSave({
              name,
              enabled,
              adoProjects: adoProjects.split(','),
              defaultBaseBranch,
              branchPrefix,
            })}
            className="h-8 rounded-md bg-primary px-4 text-sm text-white"
          >
            {t('common.save')}
          </button>
        </>
      )}
    >
      <div className="space-y-4 px-5 pb-4 pt-2">
        <div className="rounded-lg bg-fill-1 px-3 py-2">
          <div className="text-xs text-ink-3">{t('butler.projectConfig.directory')}</div>
          <div className="mt-1 break-all text-sm text-ink">{path}</div>
        </div>
        <div className="flex items-end gap-3">
          <label className="min-w-0 flex-1 text-xs text-ink-3">
            {t('butler.projectConfig.name')}
            <input
              aria-label={t('butler.projectConfig.name')}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="flex h-9 shrink-0 items-center gap-1.5 text-xs text-ink-3">
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            {t('butler.projectConfig.enabled')}
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-xs text-ink-3 sm:col-span-1">
            {t('butler.projectConfig.adoProjects')}
            <input
              aria-label={t('butler.projectConfig.adoProjects')}
              value={adoProjects}
              onChange={(event) => setAdoProjects(event.target.value)}
              placeholder="RocketChatX"
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="text-xs text-ink-3">
            {t('butler.projectConfig.baseBranch')}
            <input
              aria-label={t('butler.projectConfig.baseBranch')}
              value={defaultBaseBranch}
              onChange={(event) => setDefaultBaseBranch(event.target.value)}
              placeholder="main"
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="text-xs text-ink-3">
            {t('butler.projectConfig.branchPrefix')}
            <input
              aria-label={t('butler.projectConfig.branchPrefix')}
              value={branchPrefix}
              onChange={(event) => setBranchPrefix(event.target.value)}
              placeholder="ai/"
              className={`mt-1 ${inputCls}`}
            />
          </label>
        </div>
        {busy ? <div className="text-xs text-warning">{t('butler.projectConfig.busyWarning')}</div> : null}
      </div>
    </Dialog>
  );
}
