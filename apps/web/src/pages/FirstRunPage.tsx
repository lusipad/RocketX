import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  BellRing,
  BrainCircuit,
  Check,
  FileUp,
  GitBranch,
  ListChecks,
  Loader2,
  MessageSquareText,
  Rocket,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { useI18n, type PluralTranslateFn, type TranslateFn } from '../i18n';
import LanguageSelector from '../components/LanguageSelector';
import { applyWorkspaceConfigDefaults } from '../components/WorkspaceConfigImport';
import { autostartAvailable, updateAutostartEnabled } from '../lib/autostart';
import {
  applyDesktopDefaults,
  completeFirstRun,
  loadDesktopDefaultsRecord,
  saveAppliedDesktopDefaults,
  type DesktopDefaultsAppliedResult,
  type DesktopDefaultsEffectResult,
  type DesktopDefaultsStep,
} from '../lib/firstRun';
import { probeRocketChat } from '../lib/loginDiagnostic';
import { requestNotifyPermissionStatus } from '../lib/notify';
import { loadWorkspaceSource, parseWorkspaceConfig, type WorkspaceConfig } from '../lib/workspaceConfig';
import { fetchWorkspaceConfig } from '../lib/workspaceConfigSource';

type FirstRunStep = 'principles' | 'desktop' | 'setup';
type DesktopExitTarget = 'setup' | 'personal' | 'local';
type DesktopResults = {
  notifications: DesktopDefaultsEffectResult;
  autostart: DesktopDefaultsEffectResult;
};

function configSummary(config: WorkspaceConfig, t: TranslateFn, tp: PluralTranslateFn): { label: string; value: string }[] {
  const items: { label: string; value: string }[] = [];
  if (config.rocketChat) items.push({ label: 'Rocket.Chat', value: config.rocketChat.url });
  if (config.ado?.url) items.push({ label: 'Azure DevOps', value: config.ado.url });
  if (config.workItemTemplates) {
    items.push({
      label: t('auth.firstRun.summary.workItemTemplates'),
      value: 'url' in config.workItemTemplates
        ? config.workItemTemplates.url
        : tp(config.workItemTemplates.templates.length, 'auth.firstRun.summary.inlineTemplatesOne', 'auth.firstRun.summary.inlineTemplatesOther'),
    });
  }
  if (config.update) {
    const value = config.update.source === 'github' ? 'GitHub Release' : config.update.location || config.update.source;
    items.push({ label: t('auth.firstRun.summary.updateSource'), value });
  }
  return items;
}

function toAppliedResult(result: DesktopDefaultsEffectResult): DesktopDefaultsAppliedResult {
  if (
    result === 'enabled' ||
    result === 'skipped' ||
    result === 'denied' ||
    result === 'unavailable' ||
    result === 'failed'
  ) {
    return result;
  }
  return 'skipped';
}

function statusLabel(result: DesktopDefaultsEffectResult, t: TranslateFn): string {
  switch (result) {
    case 'pending':
      return t('auth.firstRun.status.pending');
    case 'enabled':
      return t('auth.firstRun.status.enabled');
    case 'skipped':
      return t('auth.firstRun.status.skipped');
    case 'denied':
      return t('auth.firstRun.status.denied');
    case 'unavailable':
      return t('auth.firstRun.status.unavailable');
    case 'failed':
      return t('auth.firstRun.status.failed');
    default:
      return t('auth.firstRun.status.idle');
  }
}

function statusTone(result: DesktopDefaultsEffectResult): string {
  switch (result) {
    case 'enabled':
      return 'bg-success/15 text-success';
    case 'denied':
    case 'failed':
      return 'bg-danger/10 text-danger';
    case 'unavailable':
    case 'skipped':
      return 'bg-fill-1 text-ink-2';
    case 'pending':
      return 'bg-primary-light text-primary';
    default:
      return 'bg-fill-1 text-ink-3';
  }
}

function canRetry(result: DesktopDefaultsEffectResult): boolean {
  return result === 'denied' || result === 'unavailable' || result === 'failed';
}

export default function FirstRunPage({
  onContinue,
  onEnterLocal,
}: {
  onContinue: () => void;
  onEnterLocal?: () => void;
}) {
  const { t, tp } = useI18n();
  const existingSource = loadWorkspaceSource();
  const [desktopDefaultsRecord] = useState(() =>
    loadDesktopDefaultsRecord(typeof localStorage === 'undefined' ? undefined : localStorage),
  );
  const showDesktopStep = autostartAvailable && desktopDefaultsRecord?.status === 'fresh';
  const [step, setStep] = useState<FirstRunStep>('principles');
  const [url, setUrl] = useState(existingSource?.kind === 'url' ? existingSource.url : '');
  const [config, setConfig] = useState<WorkspaceConfig | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [desktopExitTarget, setDesktopExitTarget] = useState<DesktopExitTarget>('setup');
  const [notifyChecked, setNotifyChecked] = useState(true);
  const [autostartChecked, setAutostartChecked] = useState(true);
  const [desktopBusy, setDesktopBusy] = useState(false);
  const [desktopApplied, setDesktopApplied] = useState(false);
  const [desktopSaveFailed, setDesktopSaveFailed] = useState(false);
  const [desktopResults, setDesktopResults] = useState<DesktopResults>({
    notifications: showDesktopStep ? desktopDefaultsRecord?.notifications ?? 'pending' : 'pending',
    autostart: showDesktopStep ? desktopDefaultsRecord?.autostart ?? 'pending' : 'pending',
  });
  const pageRef = useRef<HTMLElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const totalSteps = showDesktopStep ? 3 : 2;
  const currentStep = step === 'principles' ? 1 : step === 'desktop' ? 2 : totalSteps;
  const currentStepLabel = step === 'principles' ? t('auth.firstRun.step.principles') : step === 'desktop' ? t('auth.firstRun.step.desktop') : t('auth.firstRun.step.setup');

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 });
    pageRef.current?.parentElement?.scrollTo({ top: 0, left: 0 });
    pageRef.current?.scrollTo({ top: 0 });
  }, [step]);

  const acceptText = (text: string, nextSourceUrl?: string) => {
    const parsed = parseWorkspaceConfig(text);
    if (!parsed.rocketChat?.url) {
      throw new Error(t('auth.firstRun.error.missingRocketChatUrl'));
    }
    setConfig(parsed);
    setSourceUrl(nextSourceUrl);
  };

  const loadUrl = async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const parsed = await fetchWorkspaceConfig(url);
      if (!parsed.rocketChat?.url) throw new Error(t('auth.firstRun.error.missingRocketChatUrl'));
      setConfig(parsed);
      setSourceUrl(url.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.firstRun.error.loadConfigFailed'));
    } finally {
      setBusy(false);
    }
  };

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      acceptText(await file.text());
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.firstRun.error.readFileFailed'));
    }
  };

  const continueLocal = () => {
    completeFirstRun(localStorage);
    if (onEnterLocal) onEnterLocal();
    else onContinue();
  };
  const continuePersonal = () => {
    completeFirstRun(localStorage);
    onContinue();
  };

  const openDesktopStep = (target: DesktopExitTarget) => {
    setDesktopExitTarget(target);
    if (!showDesktopStep) {
      if (target === 'setup') setStep('setup');
      else if (target === 'local') continueLocal();
      else continuePersonal();
      return;
    }
    setStep('desktop');
  };

  const persistDesktopResults = (result: { notifications: DesktopDefaultsAppliedResult; autostart: DesktopDefaultsAppliedResult }) => {
    const saved = saveAppliedDesktopDefaults(localStorage, result);
    setDesktopResults(result);
    setDesktopApplied(true);
    setDesktopSaveFailed(!saved);
  };

  const retryDesktopResultSave = () => {
    const saved = saveAppliedDesktopDefaults(localStorage, {
      notifications: toAppliedResult(desktopResults.notifications),
      autostart: toAppliedResult(desktopResults.autostart),
    });
    setDesktopSaveFailed(!saved);
  };

  const applyDesktopPreferences = async () => {
    if (!showDesktopStep || desktopBusy) return;
    setDesktopBusy(true);
    setDesktopResults({
      notifications: notifyChecked ? 'pending' : 'skipped',
      autostart: autostartChecked ? 'pending' : 'skipped',
    });
    try {
      const result = await applyDesktopDefaults({
        releaseDesktop: autostartAvailable,
        notificationsChecked: notifyChecked,
        autostartChecked,
        requestNotifications: requestNotifyPermissionStatus,
        enableAutostart: () => updateAutostartEnabled(true),
        onProgress: (desktopStep, resultItem) => {
          setDesktopResults((current) => ({ ...current, [desktopStep]: resultItem }));
        },
      });
      persistDesktopResults(result);
    } finally {
      setDesktopBusy(false);
    }
  };

  const retryDesktopPreference = async (desktopStep: DesktopDefaultsStep) => {
    if (!showDesktopStep || desktopBusy) return;
    const current = desktopResults;
    setDesktopBusy(true);
    setDesktopResults((previous) => ({ ...previous, [desktopStep]: 'pending' }));
    try {
      const retried = await applyDesktopDefaults({
        releaseDesktop: autostartAvailable,
        notificationsChecked: desktopStep === 'notifications',
        autostartChecked: desktopStep === 'autostart',
        requestNotifications: requestNotifyPermissionStatus,
        enableAutostart: () => updateAutostartEnabled(true),
        onProgress: (stepName, resultItem) => {
          if (stepName === desktopStep) {
            setDesktopResults((previous) => ({ ...previous, [stepName]: resultItem }));
          }
        },
      });
      persistDesktopResults({
        notifications: desktopStep === 'notifications' ? retried.notifications : toAppliedResult(current.notifications),
        autostart: desktopStep === 'autostart' ? retried.autostart : toAppliedResult(current.autostart),
      });
    } finally {
      setDesktopBusy(false);
    }
  };

  const joinTeam = async () => {
    if (!config) return;
    setBusy(true);
    setError(null);
    let phase: 'probe' | 'apply' = 'probe';
    try {
      await probeRocketChat(config.rocketChat!.url);
      phase = 'apply';
      await applyWorkspaceConfigDefaults(config, sourceUrl);
      completeFirstRun(localStorage);
      onContinue();
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.unknownError');
      setError(phase === 'probe' ? t('auth.firstRun.error.probeFailed', { message }) : t('auth.firstRun.error.applyFailed', { message }));
    } finally {
      setBusy(false);
    }
  };

  const summary = config ? configSummary(config, t, tp) : [];

  return (
    <main ref={pageRef} className="h-full overflow-y-auto bg-fill-2 px-3 py-3 sm:px-5 sm:py-6 lg:px-10 lg:py-8">
      <div className="mx-auto min-h-[calc(100vh-1.5rem)] max-w-[1200px] overflow-hidden rounded-xl border border-line bg-surface-4 shadow-[0_22px_70px_rgba(31,35,41,0.12)] sm:min-h-[calc(100vh-3rem)] sm:rounded-2xl lg:min-h-[calc(100vh-4rem)]">
        <header className="flex h-[68px] items-center justify-between border-b border-line px-5 sm:px-8">
          <div className="flex items-center gap-3 text-sm font-semibold text-ink">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-xs font-semibold text-white">RX</span>
            RocketX
          </div>
          <div className="flex items-center gap-3 text-xs text-ink-3">
            <span className="font-medium text-primary">{currentStep} / {totalSteps}</span>
            <span className="hidden sm:inline">{currentStepLabel}</span>
            <LanguageSelector variant="compact" />
          </div>
        </header>

        {step === 'principles' ? (
          <div className="grid lg:min-h-[calc(100vh-8.25rem)] lg:grid-cols-[1.04fr_0.96fr]">
            <section className="px-6 py-9 sm:px-10 sm:py-10 lg:px-12 lg:py-8">
              <div className="inline-flex items-center gap-2 rounded-full bg-primary-light px-3 py-1.5 text-xs font-semibold text-primary">
                <BrainCircuit size={14} /> {t('auth.firstRun.principles.badge')}
              </div>
              <h1 className="mt-4 max-w-[620px] text-3xl leading-[1.16] font-semibold tracking-[-0.035em] text-ink sm:text-4xl xl:text-4xl">
                {t('auth.firstRun.principles.headlineLine1')}<br className="hidden sm:block" />{t('auth.firstRun.principles.headlineLine2')}
              </h1>
              <p className="mt-4 max-w-[590px] text-sm leading-6 text-ink-3 sm:text-base">
                {t('auth.firstRun.principles.leadPrefix')}
                <strong className="font-semibold text-ink">{t('auth.firstRun.principles.leadStrong')}</strong>{t('auth.firstRun.principles.leadSuffix')}
              </p>

              <div className="mt-6 space-y-2">
                {[
                  ['1', t('auth.firstRun.principles.pillar1Title'), t('auth.firstRun.principles.pillar1Desc')],
                  ['2', t('auth.firstRun.principles.pillar2Title'), t('auth.firstRun.principles.pillar2Desc')],
                  ['3', t('auth.firstRun.principles.pillar3Title'), t('auth.firstRun.principles.pillar3Desc')],
                ].map(([index, title, description]) => (
                  <div key={index} className="flex gap-3 rounded-xl border border-line px-4 py-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-fill-2 text-xs font-semibold text-primary">{index}</span>
                    <div className="min-w-0 sm:grid sm:flex-1 sm:grid-cols-[132px_1fr] sm:items-center sm:gap-3">
                      <strong className="block text-sm font-semibold text-ink">{title}</strong>
                      <p className="mt-1 text-xs leading-5 text-ink-3 sm:mt-0">{description}</p>
                    </div>
                  </div>
                ))}
              </div>

              <p className="mt-5 border-l-2 border-primary pl-4 text-xs leading-5 text-ink-3 sm:text-sm">
                <strong className="font-semibold text-ink">{t('auth.firstRun.principles.quoteLine1')}</strong><br />
                {t('auth.firstRun.principles.quoteLine2')}
              </p>
            </section>

            <section className="flex bg-code-bg px-6 py-9 text-code-ink sm:px-10 sm:py-9 lg:items-center lg:px-10 lg:py-6">
              <div className="w-full">
                <p className="text-xs font-semibold text-white/80">{t('auth.firstRun.principles.flowEyebrow')}</p>
                <h2 className="mt-1.5 text-xl leading-snug font-semibold sm:text-2xl">{t('auth.firstRun.principles.flowTitle')}</h2>
                <div className="mt-3 flex flex-wrap gap-2">
                  {[t('auth.firstRun.principles.sourceMessages'), t('auth.firstRun.principles.sourceMentions'), t('auth.firstRun.principles.sourceWorkItems'), t('auth.firstRun.principles.sourceCalendar')].map((source) => (
                    <span key={source} className="rounded-full border border-white/10 bg-white/[0.07] px-2.5 py-1.5 text-xs text-white/60">{source}</span>
                  ))}
                </div>

                <div className="mt-2 space-y-1.5">
                  {[
                    [t('auth.firstRun.principles.gtd1Mark'), t('auth.firstRun.principles.gtd1Title'), t('auth.firstRun.principles.gtd1Desc'), 'Capture'],
                    [t('auth.firstRun.principles.gtd2Mark'), t('auth.firstRun.principles.gtd2Title'), t('auth.firstRun.principles.gtd2Desc'), 'Clarify'],
                    [t('auth.firstRun.principles.gtd3Mark'), t('auth.firstRun.principles.gtd3Title'), t('auth.firstRun.principles.gtd3Desc'), 'Organize'],
                    [t('auth.firstRun.principles.gtd4Mark'), t('auth.firstRun.principles.gtd4Title'), t('auth.firstRun.principles.gtd4Desc'), 'Engage'],
                  ].map(([mark, title, description, label], index) => (
                    <div key={mark} className={`relative grid grid-cols-[36px_1fr_auto] items-center gap-3 rounded-xl border px-3.5 py-2.5 ${index === 3 ? 'border-primary bg-primary/15' : 'border-white/10 bg-white/[0.05]'}`}>
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.07] text-xs font-semibold text-white/80">{mark}</span>
                      <div className="min-w-0">
                        <strong className="block text-sm font-medium">{title}</strong>
                        <span className="block text-xs leading-4 text-white/50">{description}</span>
                      </div>
                      <span className="hidden text-xs text-white/80 sm:block">{label}</span>
                    </div>
                  ))}
                </div>

                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <div className="rounded-xl bg-white/[0.07] px-3.5 py-2.5">
                    <strong className="text-xs font-medium">{t('auth.firstRun.principles.boxWorkbenchTitle')}</strong>
                    <p className="mt-1 text-xs leading-5 text-white/50">{t('auth.firstRun.principles.boxWorkbenchDesc')}</p>
                  </div>
                  <div className="rounded-xl bg-white/[0.07] px-3.5 py-2.5">
                    <strong className="text-xs font-medium">{t('auth.firstRun.principles.boxButlerTitle')}</strong>
                    <p className="mt-1 text-xs leading-5 text-white/50">{t('auth.firstRun.principles.boxButlerDesc')}</p>
                  </div>
                </div>

                <div className="mt-2.5 rounded-xl bg-primary/20 px-4 py-2.5 text-xs leading-5 text-white/80">
                  {t('auth.firstRun.principles.butlerNote')}
                </div>
                <button
                  onClick={() => openDesktopStep('setup')}
                  className="mt-3 flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary text-sm font-semibold text-white hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                >
                  {showDesktopStep ? t('auth.firstRun.principles.continueDesktop') : t('auth.firstRun.principles.continueSetup')} <ArrowRight size={15} />
                </button>
                <div className="mt-1.5 flex items-center justify-center gap-4">
                  <button type="button" onClick={() => openDesktopStep('local')} className="h-8 text-xs font-medium text-white/80 hover:text-white">
                    {t('auth.firstRun.useLocally')}
                  </button>
                  <span className="text-white/25">·</span>
                  <button type="button" onClick={() => openDesktopStep('personal')} className="h-8 text-xs text-white/50 hover:text-white/75">
                    {t('auth.firstRun.principles.manualLogin')}
                  </button>
                </div>
                <button type="button" hidden tabIndex={-1}>
                  {t('auth.firstRun.principles.laterPersonal')}
                </button>
              </div>
            </section>
          </div>
        ) : step === 'desktop' ? (
          <div className="grid lg:min-h-[calc(100vh-8.25rem)] lg:grid-cols-[0.92fr_1.08fr]">
            <section className="flex flex-col justify-between bg-code-bg px-6 py-9 text-code-ink sm:px-10 lg:px-12 lg:py-12">
              <div>
                <p className="text-xs font-semibold text-white/80">{t('auth.firstRun.desktop.eyebrow')}</p>
                <h1 className="mt-4 text-3xl leading-tight font-semibold tracking-tight">
                  {t('auth.firstRun.desktop.headlineLine1')}<br />{t('auth.firstRun.desktop.headlineLine2')}
                </h1>
                <p className="mt-4 max-w-md text-sm leading-6 text-white/60">
                  {t('auth.firstRun.desktop.lead')}
                </p>

                <div className="mt-8 space-y-3">
                  <div className="rounded-xl border border-white/10 bg-white/[0.05] px-4 py-3.5">
                    <strong className="text-sm font-medium">{t('auth.firstRun.desktop.cardNotifyTitle')}</strong>
                    <p className="mt-1 text-xs leading-5 text-white/50">
                      {t('auth.firstRun.desktop.cardNotifyDesc')}
                    </p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/[0.05] px-4 py-3.5">
                    <strong className="text-sm font-medium">{t('auth.firstRun.desktop.cardAutostartTitle')}</strong>
                    <p className="mt-1 text-xs leading-5 text-white/50">
                      {t('auth.firstRun.desktop.cardAutostartDesc')}
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-8 border-t border-white/10 pt-5">
                <div className="flex items-center gap-2 text-xs text-white/50">
                  <ShieldCheck size={15} className="text-white/80" /> {t('auth.firstRun.desktop.safetyNote')}
                </div>
                <button onClick={() => setStep('principles')} className="mt-4 text-xs text-white/50 hover:text-white/75">{t('auth.firstRun.backToPrinciples')}</button>
              </div>
            </section>

            <section className="flex flex-col justify-center px-6 py-9 sm:px-10 lg:px-12 lg:py-12">
              <div className="mb-7 flex items-center gap-2 text-xs text-ink-3">
                <span className="font-medium text-primary">{t('auth.firstRun.desktop.step1')}</span>
                <span>·</span>
                <span>{t('auth.firstRun.desktop.step2')}</span>
                <span>·</span>
                <span>{t('auth.firstRun.desktop.step3')}</span>
              </div>

              <BellRing size={28} className="text-primary" />
              <h2 className="mt-4 text-xl font-semibold text-ink">{t('auth.firstRun.desktop.title')}</h2>
              <p className="mt-2 max-w-xl text-sm leading-6 text-ink-3">
                {t('auth.firstRun.desktop.subtitle')}
              </p>

              <div className="mt-6 space-y-3">
                <label className="flex items-start gap-3 rounded-xl border border-line px-4 py-3.5">
                  <input
                    type="checkbox"
                    checked={notifyChecked}
                    disabled={desktopApplied || desktopBusy}
                    onChange={(event) => setNotifyChecked(event.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-line text-primary focus:ring-primary-light disabled:cursor-not-allowed"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="text-sm font-medium text-ink">{t('auth.firstRun.desktop.enableNotify')}</strong>
                      {(desktopApplied || desktopBusy) && (
                        <span className={`rounded-full px-2 py-0.5 text-xs ${statusTone(desktopResults.notifications)}`}>
                          {statusLabel(desktopResults.notifications, t)}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs leading-5 text-ink-3">
                      {t('auth.firstRun.desktop.enableNotifyDesc')}
                    </p>
                    {desktopApplied && canRetry(desktopResults.notifications) && (
                      <button
                        onClick={(event) => {
                          event.preventDefault();
                          void retryDesktopPreference('notifications');
                        }}
                        disabled={desktopBusy}
                        className="mt-2 text-xs font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:opacity-50"
                      >
                        {t('auth.firstRun.desktop.retryNotify')}
                      </button>
                    )}
                  </div>
                </label>

                <label className="flex items-start gap-3 rounded-xl border border-line px-4 py-3.5">
                  <input
                    type="checkbox"
                    checked={autostartChecked}
                    disabled={desktopApplied || desktopBusy}
                    onChange={(event) => setAutostartChecked(event.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-line text-primary focus:ring-primary-light disabled:cursor-not-allowed"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="text-sm font-medium text-ink">{t('auth.firstRun.desktop.enableAutostart')}</strong>
                      {(desktopApplied || desktopBusy) && (
                        <span className={`rounded-full px-2 py-0.5 text-xs ${statusTone(desktopResults.autostart)}`}>
                          {statusLabel(desktopResults.autostart, t)}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs leading-5 text-ink-3">
                      {t('auth.firstRun.desktop.enableAutostartDesc')}
                    </p>
                    {desktopApplied && canRetry(desktopResults.autostart) && (
                      <button
                        onClick={(event) => {
                          event.preventDefault();
                          void retryDesktopPreference('autostart');
                        }}
                        disabled={desktopBusy}
                        className="mt-2 text-xs font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:opacity-50"
                      >
                        {t('auth.firstRun.desktop.retryAutostart')}
                      </button>
                    )}
                  </div>
                </label>
              </div>

              <div className="mt-6 rounded-xl bg-fill-1 px-4 py-3 text-xs leading-5 text-ink-3">
                {t('auth.firstRun.desktop.reviewHint')}
              </div>

              {desktopSaveFailed && (
                <div role="alert" className="mt-3 rounded-xl bg-danger/10 px-4 py-3 text-xs leading-5 text-danger">
                  {t('auth.firstRun.desktop.saveFailed')}
                  <button onClick={retryDesktopResultSave} className="ml-1 font-medium underline">{t('auth.firstRun.desktop.retrySave')}</button>
                </div>
              )}

              {!desktopApplied ? (
                <button
                  onClick={() => void applyDesktopPreferences()}
                  disabled={desktopBusy}
                  className="mt-6 flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {desktopBusy ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />}
                  {desktopBusy ? t('auth.firstRun.desktop.applying') : t('auth.firstRun.desktop.applyAndContinue')}
                </button>
              ) : (
                <button
                  onClick={() => {
                    if (desktopExitTarget === 'setup') setStep('setup');
                    else if (desktopExitTarget === 'local') continueLocal();
                    else continuePersonal();
                  }}
                  disabled={desktopBusy}
                  className="mt-6 flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {desktopExitTarget === 'setup' ? t('auth.firstRun.desktop.nextSetup') : desktopExitTarget === 'local' ? t('auth.firstRun.desktop.nextLocal') : t('auth.firstRun.desktop.nextPersonal')}
                  <ArrowRight size={14} />
                </button>
              )}
            </section>
          </div>
        ) : (
          <div className="grid lg:min-h-[calc(100vh-8.25rem)] lg:grid-cols-[0.88fr_1.12fr]">
            <section className="flex flex-col justify-between bg-code-bg px-6 py-9 text-code-ink sm:px-10 lg:px-12 lg:py-12">
              <div>
                <p className="text-xs font-semibold text-white/80">{t('auth.firstRun.setup.eyebrow')}</p>
                <h1 className="mt-4 text-3xl leading-tight font-semibold tracking-tight">
                  {t('auth.firstRun.setup.headlineLine1')}<br />{t('auth.firstRun.setup.headlineLine2')}<br />{t('auth.firstRun.setup.headlineLine3')}
                </h1>
                <p className="mt-4 max-w-md text-sm leading-6 text-white/60">
                  {t('auth.firstRun.setup.lead')}
                </p>

                <div className="mt-8 space-y-3">
                  <div className="flex gap-3 rounded-xl border border-white/10 bg-white/[0.05] px-4 py-3.5">
                    <MessageSquareText className="mt-0.5 shrink-0 text-white/80" size={18} />
                    <div><strong className="text-sm font-medium">{t('auth.firstRun.setup.roleMessagesTitle')}</strong><p className="mt-1 text-xs leading-5 text-white/50">{t('auth.firstRun.setup.roleMessagesDesc')}</p></div>
                  </div>
                  <div className="flex gap-3 rounded-xl border border-white/10 bg-white/[0.05] px-4 py-3.5">
                    <ListChecks className="mt-0.5 shrink-0 text-white/80" size={18} />
                    <div><strong className="text-sm font-medium">{t('auth.firstRun.setup.roleWorkbenchTitle')}</strong><p className="mt-1 text-xs leading-5 text-white/50">{t('auth.firstRun.setup.roleWorkbenchDesc')}</p></div>
                  </div>
                  <div className="flex gap-3 rounded-xl border border-primary/60 bg-primary/15 px-4 py-3.5">
                    <Sparkles className="mt-0.5 shrink-0 text-white/80" size={18} />
                    <div><strong className="text-sm font-medium">{t('auth.firstRun.setup.roleButlerTitle')}</strong><p className="mt-1 text-xs leading-5 text-white/50">{t('auth.firstRun.setup.roleButlerDesc')}</p></div>
                  </div>
                </div>
              </div>

              <div className="mt-8 border-t border-white/10 pt-5">
                <div className="flex items-center gap-2 text-xs text-white/50">
                  <ShieldCheck size={15} className="text-white/80" /> {t('auth.firstRun.setup.safetyNote')}
                </div>
                <button onClick={() => setStep(showDesktopStep ? 'desktop' : 'principles')} className="mt-4 text-xs text-white/50 hover:text-white/75">
                  {showDesktopStep ? t('auth.firstRun.setup.backToDesktop') : t('auth.firstRun.backToPrinciples')}
                </button>
              </div>
            </section>

            <section className="flex flex-col justify-center px-6 py-9 sm:px-10 lg:px-12 lg:py-12">
              <div className="mb-7 flex items-center gap-2 text-xs text-ink-3">
                <span className="font-medium text-primary">{t('auth.firstRun.setup.step1')}</span>
                <span>·</span>
                <span>{t('auth.firstRun.setup.step2')}</span>
                <span>·</span>
                <span>{t('auth.firstRun.setup.step3')}</span>
              </div>

              {!config ? (
                <>
                  <GitBranch size={28} className="text-primary" />
                  <h2 className="mt-4 text-xl font-semibold text-ink">{t('auth.firstRun.setup.joinTeamTitle')}</h2>
                  <p className="mt-2 max-w-xl text-sm leading-6 text-ink-3">
                    {t('auth.firstRun.setup.joinTeamDesc')}
                    {null}
                  </p>

                  <label className="mt-6 block">
                    <span className="mb-1.5 block text-sm text-ink-2">{t('auth.firstRun.setup.configUrlLabel')}</span>
                    <input
                      value={url}
                      onChange={(event) => {
                        setUrl(event.target.value);
                        setError(null);
                      }}
                      placeholder="https://git.example.com/team/config/raw/rcx.workspace.json"
                      autoFocus
                      className="h-10 w-full rounded-md border border-line px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary-light"
                    />
                  </label>

                  {error && <div className="mt-3 rounded-lg bg-danger/10 px-3 py-2.5 text-sm leading-5 text-danger">{error}</div>}

                  <button
                    onClick={() => void loadUrl()}
                    disabled={!url.trim() || busy}
                    className="mt-5 flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
                    {busy ? t('auth.firstRun.setup.loadingConfig') : t('auth.firstRun.setup.loadConfig')}
                  </button>

                  <button
                    onClick={() => fileRef.current?.click()}
                    className="mt-2 flex h-9 w-full items-center justify-center gap-2 text-sm text-ink-3 hover:text-primary"
                  >
                    <FileUp size={14} /> {t('auth.firstRun.setup.pickLocalFile')}
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".json,application/json"
                    hidden
                    onChange={(event) => {
                      void loadFile(event.target.files?.[0]);
                      event.target.value = '';
                    }}
                  />

                  <div className="mt-7 border-t border-line pt-5 text-center text-xs text-ink-3">
                    {t('auth.firstRun.setup.noConfig')}{' '}
                    <button type="button" onClick={continuePersonal} className="text-primary hover:underline">{t('auth.firstRun.setup.manualConnect')}</button>
                    {' · '}
                    <button type="button" onClick={continueLocal} className="font-medium text-primary hover:underline">{t('auth.firstRun.useLocally')}</button>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-success/15 text-success">
                    <Check size={22} />
                  </div>
                  <h2 className="mt-4 text-xl font-semibold text-ink">{t('auth.firstRun.setup.joinNamedWorkspace', { name: config.name || t('auth.workspace.defaultTitle') })}</h2>
                  <p className="mt-2 max-w-xl text-sm leading-6 text-ink-3">
                    {t('auth.firstRun.setup.applyHint')}
                    {null}
                  </p>

                  <div className="mt-5 divide-y divide-line rounded-lg border border-line">
                    {summary.map((item) => (
                      <div key={item.label} className="flex gap-3 px-3 py-2.5 text-xs">
                        <Check size={14} className="mt-0.5 shrink-0 text-success" />
                        <span className="w-20 shrink-0 text-ink-3">{item.label}</span>
                        <span className="min-w-0 flex-1 truncate text-ink-2" title={item.value}>{item.value}</span>
                      </div>
                    ))}
                  </div>

                  {error && <div className="mt-3 rounded-lg bg-danger/10 px-3 py-2.5 text-sm leading-5 text-danger">{error}</div>}

                  <button
                    onClick={() => void joinTeam()}
                    disabled={busy}
                    className="mt-6 flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
                    {busy ? t('auth.firstRun.setup.verifyingRocketChat') : t('auth.firstRun.setup.confirmAndContinue')}
                  </button>
                  <button
                    onClick={() => {
                      setConfig(null);
                      setError(null);
                    }}
                    className="mt-2 h-9 text-sm text-ink-3 hover:text-primary"
                  >
                    {t('auth.firstRun.setup.changeUrl')}
                  </button>
                </>
              )}
            </section>
          </div>
        )}
      </div>
    </main>
  );
}
