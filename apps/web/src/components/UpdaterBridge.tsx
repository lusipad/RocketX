import { useEffect } from 'react';
import { t } from '../i18n';
import { isTauri } from '../lib/http';
import {
  checkGithubUpdate,
  checkHttpUpdate,
  installedAppVersion,
  launchDirInstaller,
  loadUpdateSource,
  probeConfiguredSource,
  takeUpdateResult,
} from '../lib/updateSource';
import { humanError, toast } from '../stores/toast';
import { relaunchDesktop } from '../platform/desktopProcess';

declare const __APP_VERSION__: string;

let checked = false;

/** GitHub 源:原生 updater 通道,带签名校验与全自动下载安装 */
async function checkGithubSource(installed: string): Promise<void> {
  const update = await checkGithubUpdate(installed);
  if (!update) return;

  toast.show({
    kind: 'info',
    message: t('nav.updater.available', { version: update.version }),
    duration: 0,
    action: {
      label: t('nav.updater.updateAndRestart'),
      onClick: () => {
        void (async () => {
          const freshUpdate = await checkGithubUpdate(installed);
          if (!freshUpdate) return;
          const toastId = toast.loading(t('nav.updater.downloading', { version: freshUpdate.version }));
          try {
            await freshUpdate.downloadAndInstall((event) => {
              if (event.event === 'Finished') {
                toast.update(toastId, { kind: 'success', message: t('nav.updater.installedRestarting') });
              }
            });
            await relaunchDesktop();
          } catch (error) {
            toast.update(toastId, { kind: 'error', message: humanError(error, t('nav.updater.failed')) });
          }
        })().catch((error) => toast.error(error, t('nav.updater.failed')));
      },
    },
  });
}

/** 自定义源(内网 HTTP / 共享目录):检测提醒 + 引导安装(issue #106) */
async function checkCustomSource(installed: string): Promise<void> {
  const config = loadUpdateSource();
  if (config.kind === 'http') {
    const update = await checkHttpUpdate(config.location, installed);
    if (!update) return;
    toast.show({
      kind: 'info',
      message: t('nav.updater.availableSignedHttp', { version: update.version }),
      duration: 0,
      action: {
        label: t('nav.updater.updateAndRestart'),
        onClick: () => {
          void (async () => {
            const freshUpdate = await checkHttpUpdate(config.location, installed);
            if (!freshUpdate) return;
            const toastId = toast.loading(t('nav.updater.downloadingAndVerifying', { version: freshUpdate.version }));
            try {
              await freshUpdate.downloadAndInstall();
              toast.update(toastId, { kind: 'success', message: t('nav.updater.installedRestarting') });
              await relaunchDesktop();
            } catch (error) {
              toast.update(toastId, { kind: 'error', message: humanError(error, t('nav.updater.failed')) });
            }
          })().catch((error) => toast.error(error, t('nav.updater.failed')));
        },
      },
    });
    return;
  }
  const probe = await probeConfiguredSource(config, installed);
  if (!probe.hasUpdate) return;

  const action = probe.installerPath && probe.sha256 && probe.installerType
    ? {
        label: t('nav.updater.updateToVersionAndRestart', { version: probe.version }),
        onClick: () => {
          const toastId = toast.loading(t('nav.updater.exitingAndInstalling', { version: probe.version }));
          void launchDirInstaller({
            dir: config.location,
            path: probe.installerPath!,
            signature: probe.signature,
            sha256: probe.sha256!,
            expectedVersion: probe.version,
            installerType: probe.installerType!,
          }).catch((error) => {
            toast.update(toastId, { kind: 'error', message: String(error) });
          });
        },
      }
    : undefined;

  toast.show({
    kind: 'info',
    message: t(
      probe.signature ? 'nav.updater.availableSignedDir' : 'nav.updater.availableUnsignedDir',
      { version: probe.version },
    ),
    duration: 0,
    ...(action ? { action } : {}),
  });
}

export default function UpdaterBridge() {
  useEffect(() => {
    if (import.meta.env.DEV || !isTauri || checked) return;
    checked = true;

    void takeUpdateResult()
      .then((result) => {
        if (!result) return;
        if (result.status === 'success') {
          toast.success(result.message || t('nav.updater.updated', { version: result.version }));
        } else {
          toast.error(result.message || t('nav.updater.installIncomplete'), t('nav.updater.failed'));
        }
      })
      .catch(() => undefined);

    const config = loadUpdateSource();
    // 版本比较一律以「当前真正在跑的版本」为准（issue #376）：构建期常量和
    // updater 自报的 currentVersion 都可能与已安装版本对不上，一旦对不上就会
    // 把同版本甚至更旧的版本当成新版本提示升级。
    void installedAppVersion(__APP_VERSION__)
      .then((installed) =>
        config.kind === 'github' ? checkGithubSource(installed) : checkCustomSource(installed),
      )
      .catch((error) => {
        // 默认 GitHub 源离线时不打扰；用户显式配置的内网源失败必须可见，避免长期误以为在自动更新。
        if (config.kind !== 'github') toast.error(error, t('nav.updater.customSourceFailed'));
      });
  }, []);

  return null;
}
