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
type DesktopExitTarget = 'setup' | 'personal';
type DesktopResults = {
  notifications: DesktopDefaultsEffectResult;
  autostart: DesktopDefaultsEffectResult;
};

function configSummary(config: WorkspaceConfig): { label: string; value: string }[] {
  const items: { label: string; value: string }[] = [];
  if (config.rocketChat) items.push({ label: 'Rocket.Chat', value: config.rocketChat.url });
  if (config.ado?.url) items.push({ label: 'Azure DevOps', value: config.ado.url });
  if (config.workItemTemplates) {
    items.push({
      label: '工作项模板',
      value: 'url' in config.workItemTemplates
        ? config.workItemTemplates.url
        : `${config.workItemTemplates.templates.length} 个内联模板`,
    });
  }
  if (config.update) {
    const value = config.update.source === 'github' ? 'GitHub Release' : config.update.location || config.update.source;
    items.push({ label: '更新源', value });
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

function statusLabel(result: DesktopDefaultsEffectResult): string {
  switch (result) {
    case 'pending':
      return '正在设置…';
    case 'enabled':
      return '已开启';
    case 'skipped':
      return '已跳过';
    case 'denied':
      return '未授权';
    case 'unavailable':
      return '当前平台不可用';
    case 'failed':
      return '设置失败';
    default:
      return '待选择';
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

export default function FirstRunPage({ onContinue }: { onContinue: () => void }) {
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
  const currentStepLabel = step === 'principles' ? '为什么这样设计' : step === 'desktop' ? '桌面默认设置' : '连接你的工作';

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 });
    pageRef.current?.parentElement?.scrollTo({ top: 0, left: 0 });
    pageRef.current?.scrollTo({ top: 0 });
  }, [step]);

  const acceptText = (text: string, nextSourceUrl?: string) => {
    const parsed = parseWorkspaceConfig(text);
    if (!parsed.rocketChat?.url) {
      throw new Error('团队配置必须包含 Rocket.Chat 服务器地址');
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
      if (!parsed.rocketChat?.url) throw new Error('团队配置必须包含 Rocket.Chat 服务器地址');
      setConfig(parsed);
      setSourceUrl(url.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法读取团队配置');
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
      setError(err instanceof Error ? err.message : '配置文件无法读取');
    }
  };

  const continuePersonal = () => {
    completeFirstRun(localStorage);
    onContinue();
  };

  const openDesktopStep = (target: DesktopExitTarget) => {
    setDesktopExitTarget(target);
    if (!showDesktopStep) {
      if (target === 'setup') setStep('setup');
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
      const message = err instanceof Error ? err.message : '未知错误';
      setError(phase === 'probe' ? `Rocket.Chat 验证失败：${message}` : `团队配置无法应用：${message}`);
    } finally {
      setBusy(false);
    }
  };

  const summary = config ? configSummary(config) : [];

  return (
    <main ref={pageRef} className="min-h-full overflow-y-auto bg-fill-2 px-3 py-3 sm:px-5 sm:py-6 lg:px-10 lg:py-8">
      <div className="mx-auto min-h-[calc(100vh-1.5rem)] max-w-[1200px] overflow-hidden rounded-xl border border-line bg-surface-4 shadow-[0_22px_70px_rgba(31,35,41,0.12)] sm:min-h-[calc(100vh-3rem)] sm:rounded-2xl lg:min-h-[calc(100vh-4rem)]">
        <header className="flex h-[68px] items-center justify-between border-b border-line px-5 sm:px-8">
          <div className="flex items-center gap-3 text-sm font-semibold text-ink">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-xs font-semibold text-white">RX</span>
            RocketX
          </div>
          <div className="flex items-center gap-2 text-xs text-ink-3">
            <span className="font-medium text-primary">{currentStep} / {totalSteps}</span>
            <span className="hidden sm:inline">{currentStepLabel}</span>
          </div>
        </header>

        {step === 'principles' ? (
          <div className="grid lg:min-h-[calc(100vh-8.25rem)] lg:grid-cols-[1.04fr_0.96fr]">
            <section className="px-6 py-9 sm:px-10 sm:py-10 lg:px-12 lg:py-8">
              <div className="inline-flex items-center gap-2 rounded-full bg-primary-light px-3 py-1.5 text-xs font-semibold text-primary">
                <BrainCircuit size={14} /> 底层方法 · GTD，不是功能清单
              </div>
              <h1 className="mt-4 max-w-[620px] text-3xl leading-[1.16] font-semibold tracking-[-0.035em] text-ink sm:text-4xl xl:text-4xl">
                把大脑从“记住所有事”里解放出来，<br className="hidden sm:block" />把注意力留给正在做的事。
              </h1>
              <p className="mt-4 max-w-[590px] text-sm leading-6 text-ink-3 sm:text-base">
                RocketX 不让你处理更多信息。它把消息、承诺和工作放进一个
                <strong className="font-semibold text-ink">可信的外部系统</strong>：先收住，再明确下一步，最后只在值得你关注时出现。
              </p>

              <div className="mt-6 space-y-2">
                {[
                  ['1', '先可靠地收住', '事情不再靠脑内提醒，也不会因为暂时不看消息而丢失。'],
                  ['2', '让下一步清楚', '工作台保存事实、状态、负责人和时间，不靠 AI 猜测。'],
                  ['3', '保护稀缺注意力', '管家可以看很多，但只有真正需要你时才开口；复杂工作再按需调用 Skill。'],
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
                <strong className="font-semibold text-ink">我们的目标不是“零遗漏”地提醒你，</strong><br />
                而是让你相信：没出现的事情，现在不需要占用你的注意力。
              </p>
            </section>

            <section className="flex bg-code-bg px-6 py-9 text-code-ink sm:px-10 sm:py-9 lg:items-center lg:px-10 lg:py-6">
              <div className="w-full">
                <p className="text-xs font-semibold text-white/80">一件事如何离开大脑，又在正确时刻回来</p>
                <h2 className="mt-1.5 text-xl leading-snug font-semibold sm:text-2xl">GTD 是运行方式，注意力是检验标准。</h2>
                <div className="mt-3 flex flex-wrap gap-2">
                  {['群消息', '@提及', '工作项', '日程'].map((source) => (
                    <span key={source} className="rounded-full border border-white/10 bg-white/[0.07] px-2.5 py-1.5 text-xs text-white/60">{source}</span>
                  ))}
                </div>

                <div className="mt-2 space-y-1.5">
                  {[
                    ['收', '捕获事实', '保留来源和上下文，不急着打断你。', 'Capture'],
                    ['清', '理清下一步', '这是信息、承诺，还是需要执行的工作？', 'Clarify'],
                    ['放', '放进可信位置', '确定性事项归工作台，复杂目标交给管家。', 'Organize'],
                    ['回', '该处理时再出现', '到期、受阻或需要决定时，带着动作回来。', 'Engage'],
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
                    <strong className="text-xs font-medium">工作台 · 事实与计划</strong>
                    <p className="mt-1 text-xs leading-5 text-white/50">你直接掌握的确定性界面。</p>
                  </div>
                  <div className="rounded-xl bg-white/[0.07] px-3.5 py-2.5">
                    <strong className="text-xs font-medium">管家 · 判断与执行</strong>
                    <p className="mt-1 text-xs leading-5 text-white/50">来源可看、过程可停、越界前确认。</p>
                  </div>
                </div>

                <div className="mt-2.5 rounded-xl bg-primary/20 px-4 py-2.5 text-xs leading-5 text-white/80">
                  管家的价值不在于说了多少，而在于替你判断了多少事情此刻不值得打扰。
                </div>
                <button
                  onClick={() => openDesktopStep('setup')}
                  className="mt-3 flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary text-sm font-semibold text-white hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                >
                  {showDesktopStep ? '继续：设置桌面体验' : '继续：选择如何加入'} <ArrowRight size={15} />
                </button>
                <button onClick={() => openDesktopStep('personal')} className="mt-1 h-8 w-full text-xs text-white/50 hover:text-white/75">
                  稍后连接，先进入个人设置
                </button>
              </div>
            </section>
          </div>
        ) : step === 'desktop' ? (
          <div className="grid lg:min-h-[calc(100vh-8.25rem)] lg:grid-cols-[0.92fr_1.08fr]">
            <section className="flex flex-col justify-between bg-code-bg px-6 py-9 text-code-ink sm:px-10 lg:px-12 lg:py-12">
              <div>
                <p className="text-xs font-semibold text-white/80">桌面端默认体验</p>
                <h1 className="mt-4 text-3xl leading-tight font-semibold tracking-tight">
                  第一次启动时，<br />把该交给系统的事交给系统。
                </h1>
                <p className="mt-4 max-w-md text-sm leading-6 text-white/60">
                  RocketX 会把桌面通知偏好默认设为全部消息，并按你的勾选申请系统通知、开启登录后自动启动。
                </p>

                <div className="mt-8 space-y-3">
                  <div className="rounded-xl border border-white/10 bg-white/[0.05] px-4 py-3.5">
                    <strong className="text-sm font-medium">通知偏好默认全部消息</strong>
                    <p className="mt-1 text-xs leading-5 text-white/50">
                      这一步只决定是否向操作系统申请通知权限；权限结果由操作系统保存，之后可在“设置 → 通知”关闭。
                    </p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/[0.05] px-4 py-3.5">
                    <strong className="text-sm font-medium">登录启动遵循静默托盘</strong>
                    <p className="mt-1 text-xs leading-5 text-white/50">
                      启动项由操作系统保存，之后可在“设置 → 桌面”关闭；登录后自动启动时仍按静默托盘方式运行。
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-8 border-t border-white/10 pt-5">
                <div className="flex items-center gap-2 text-xs text-white/50">
                  <ShieldCheck size={15} className="text-white/80" /> 只在你明确点击“应用并继续”后才写入系统级默认
                </div>
                <button onClick={() => setStep('principles')} className="mt-4 text-xs text-white/50 hover:text-white/75">← 返回设计理念</button>
              </div>
            </section>

            <section className="flex flex-col justify-center px-6 py-9 sm:px-10 lg:px-12 lg:py-12">
              <div className="mb-7 flex items-center gap-2 text-xs text-ink-3">
                <span className="font-medium text-primary">1 申请系统权限</span>
                <span>·</span>
                <span>2 保留结果</span>
                <span>·</span>
                <span>3 再决定下一步</span>
              </div>

              <BellRing size={28} className="text-primary" />
              <h2 className="mt-4 text-xl font-semibold text-ink">桌面默认设置</h2>
              <p className="mt-2 max-w-xl text-sm leading-6 text-ink-3">
                这一步只会处理桌面通知和登录启动。两项彼此独立，任何一项失败、未授权或当前平台不可用，都不会阻断你继续进入下一步。
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
                      <strong className="text-sm font-medium text-ink">允许系统通知</strong>
                      {(desktopApplied || desktopBusy) && (
                        <span className={`rounded-full px-2 py-0.5 text-xs ${statusTone(desktopResults.notifications)}`}>
                          {statusLabel(desktopResults.notifications)}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs leading-5 text-ink-3">
                      应用内通知偏好默认是全部消息；如果操作系统拒绝授权，你之后仍可在系统设置和 RocketX 设置里调整。
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
                        重试通知权限
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
                      <strong className="text-sm font-medium text-ink">登录系统后启动 RocketX</strong>
                      {(desktopApplied || desktopBusy) && (
                        <span className={`rounded-full px-2 py-0.5 text-xs ${statusTone(desktopResults.autostart)}`}>
                          {statusLabel(desktopResults.autostart)}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs leading-5 text-ink-3">
                      正式桌面版会把开机启动交给操作系统保存；启动后仍按静默托盘运行，不会抢占当前窗口。
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
                        重试开机启动
                      </button>
                    )}
                  </div>
                </label>
              </div>

              <div className="mt-6 rounded-xl bg-fill-1 px-4 py-3 text-xs leading-5 text-ink-3">
                首次应用后，结果会保留在当前页供你确认；确认无误后，再继续加入团队或进入个人设置。
              </div>

              {desktopSaveFailed && (
                <div role="alert" className="mt-3 rounded-xl bg-danger/10 px-4 py-3 text-xs leading-5 text-danger">
                  系统设置已经执行，但结果尚未保存在此设备。
                  <button onClick={retryDesktopResultSave} className="ml-1 font-medium underline">重试保存结果</button>
                </div>
              )}

              {!desktopApplied ? (
                <button
                  onClick={() => void applyDesktopPreferences()}
                  disabled={desktopBusy}
                  className="mt-6 flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {desktopBusy ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />}
                  {desktopBusy ? '正在应用桌面默认…' : '应用并继续'}
                </button>
              ) : (
                <button
                  onClick={() => {
                    if (desktopExitTarget === 'setup') setStep('setup');
                    else continuePersonal();
                  }}
                  disabled={desktopBusy}
                  className="mt-6 flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {desktopExitTarget === 'setup' ? '继续加入团队' : '进入个人设置'}
                  <ArrowRight size={14} />
                </button>
              )}
            </section>
          </div>
        ) : (
          <div className="grid lg:min-h-[calc(100vh-8.25rem)] lg:grid-cols-[0.88fr_1.12fr]">
            <section className="flex flex-col justify-between bg-code-bg px-6 py-9 text-code-ink sm:px-10 lg:px-12 lg:py-12">
              <div>
                <p className="text-xs font-semibold text-white/80">少一些入口，多一个清楚的分工</p>
                <h1 className="mt-4 text-3xl leading-tight font-semibold tracking-tight">
                  消息用来沟通，<br />工作台用来确定，<br />管家用来完成。
                </h1>
                <p className="mt-4 max-w-md text-sm leading-6 text-white/60">
                  事情在哪里发生，就在哪里处理。复杂工作只需自然地交代，管家会按需调用对应 Skill。
                </p>

                <div className="mt-8 space-y-3">
                  <div className="flex gap-3 rounded-xl border border-white/10 bg-white/[0.05] px-4 py-3.5">
                    <MessageSquareText className="mt-0.5 shrink-0 text-white/80" size={18} />
                    <div><strong className="text-sm font-medium">消息</strong><p className="mt-1 text-xs leading-5 text-white/50">团队讨论、上下文和原始事实留在这里。</p></div>
                  </div>
                  <div className="flex gap-3 rounded-xl border border-white/10 bg-white/[0.05] px-4 py-3.5">
                    <ListChecks className="mt-0.5 shrink-0 text-white/80" size={18} />
                    <div><strong className="text-sm font-medium">工作台</strong><p className="mt-1 text-xs leading-5 text-white/50">计划、状态和关键工作由你确定，结果可追踪。</p></div>
                  </div>
                  <div className="flex gap-3 rounded-xl border border-primary/60 bg-primary/15 px-4 py-3.5">
                    <Sparkles className="mt-0.5 shrink-0 text-white/80" size={18} />
                    <div><strong className="text-sm font-medium">管家</strong><p className="mt-1 text-xs leading-5 text-white/50">回答、整理或执行；需要时才调用 Skill。</p></div>
                  </div>
                </div>
              </div>

              <div className="mt-8 border-t border-white/10 pt-5">
                <div className="flex items-center gap-2 text-xs text-white/50">
                  <ShieldCheck size={15} className="text-white/80" /> 来源可看 · 步骤可停 · 按既定权限执行
                </div>
                <button onClick={() => setStep(showDesktopStep ? 'desktop' : 'principles')} className="mt-4 text-xs text-white/50 hover:text-white/75">
                  ← 返回{showDesktopStep ? '桌面默认' : '设计理念'}
                </button>
              </div>
            </section>

            <section className="flex flex-col justify-center px-6 py-9 sm:px-10 lg:px-12 lg:py-12">
              <div className="mb-7 flex items-center gap-2 text-xs text-ink-3">
                <span className="font-medium text-primary">1 加入团队</span>
                <span>·</span>
                <span>2 验证身份</span>
                <span>·</span>
                <span>3 开始工作</span>
              </div>

              {!config ? (
                <>
                  <GitBranch size={28} className="text-primary" />
                  <h2 className="mt-4 text-xl font-semibold text-ink">加入团队工作区</h2>
                  <p className="mt-2 max-w-xl text-sm leading-6 text-ink-3">
                    粘贴团队提供的配置链接，一次设置 Rocket.Chat、Azure DevOps、AI、模板和更新源。
                    配置可以放在 Git 仓库中，但必须使用本机无需登录即可访问的 rcx.workspace.json Raw 地址。
                  </p>

                  <label className="mt-6 block">
                    <span className="mb-1.5 block text-sm text-ink-2">团队配置地址</span>
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
                    {busy ? '正在读取团队配置…' : '读取团队配置'}
                  </button>

                  <button
                    onClick={() => fileRef.current?.click()}
                    className="mt-2 flex h-9 w-full items-center justify-center gap-2 text-sm text-ink-3 hover:text-primary"
                  >
                    <FileUp size={14} /> 从本地选择 rcx.workspace.json
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
                    没有团队配置？{' '}
                    <button onClick={continuePersonal} className="text-primary hover:underline">进入个人设置</button>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-success/15 text-success">
                    <Check size={22} />
                  </div>
                  <h2 className="mt-4 text-xl font-semibold text-ink">加入「{config.name || '团队工作区'}」</h2>
                  <p className="mt-2 max-w-xl text-sm leading-6 text-ink-3">
                    以下非敏感配置将写入本机。继续前会验证 Rocket.Chat；ADO、AI 和模板在填写个人凭据后验证。
                    用户名、密码、PAT 和 AI 密钥不会从团队配置读取。
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
                    {busy ? '正在验证 Rocket.Chat…' : '确认并继续'}
                  </button>
                  <button
                    onClick={() => {
                      setConfig(null);
                      setError(null);
                    }}
                    className="mt-2 h-9 text-sm text-ink-3 hover:text-primary"
                  >
                    返回修改地址
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
