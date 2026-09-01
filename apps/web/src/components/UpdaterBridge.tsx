import { useEffect } from 'react';
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
    message: `RocketX ${update.version} 已发布`,
    duration: 0,
    action: {
      label: '更新并重启',
      onClick: () => {
        void (async () => {
          const freshUpdate = await checkGithubUpdate(installed);
          if (!freshUpdate) return;
          const toastId = toast.loading(`正在下载 RocketX ${freshUpdate.version}…`);
          try {
            await freshUpdate.downloadAndInstall((event) => {
              if (event.event === 'Finished') {
                toast.update(toastId, { kind: 'success', message: '更新已安装，正在重启…' });
              }
            });
            await relaunchDesktop();
          } catch (error) {
            toast.update(toastId, { kind: 'error', message: humanError(error, '自动更新失败') });
          }
        })().catch((error) => toast.error(error, '自动更新失败'));
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
      message: `RocketX ${update.version} 已发布（签名内网源）`,
      duration: 0,
      action: {
        label: '更新并重启',
        onClick: () => {
          void (async () => {
            const freshUpdate = await checkHttpUpdate(config.location, installed);
            if (!freshUpdate) return;
            const toastId = toast.loading(`正在下载并验证 RocketX ${freshUpdate.version}…`);
            try {
              await freshUpdate.downloadAndInstall();
              toast.update(toastId, { kind: 'success', message: '更新已安装，正在重启…' });
              await relaunchDesktop();
            } catch (error) {
              toast.update(toastId, { kind: 'error', message: humanError(error, '自动更新失败') });
            }
          })().catch((error) => toast.error(error, '自动更新失败'));
        },
      },
    });
    return;
  }
  const probe = await probeConfiguredSource(config, installed);
  if (!probe.hasUpdate) return;

  const action = probe.installerPath && probe.sha256 && probe.installerType
    ? {
        label: `更新到 v${probe.version} 并重启`,
        onClick: () => {
          const toastId = toast.loading(`正在退出并安装 RocketX ${probe.version}…`);
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
    message: `RocketX ${probe.version} 已发布（${probe.signature ? '签名共享目录' : '未签名共享目录，已固定 SHA-256'}）`,
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
          toast.success(result.message || `RocketX ${result.version} 已更新`);
        } else {
          toast.error(result.message || '安装未完成', '自动更新失败');
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
        if (config.kind !== 'github') toast.error(error, '自定义更新源检查失败');
      });
  }, []);

  return null;
}
