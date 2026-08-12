import { useEffect } from 'react';
import { isTauri } from '../lib/http';
import {
  checkGithubUpdate,
  checkHttpUpdate,
  launchDirInstaller,
  loadUpdateSource,
  probeConfiguredSource,
  takeUpdateResult,
} from '../lib/updateSource';
import { humanError, toast } from '../stores/toast';

declare const __APP_VERSION__: string;

let checked = false;

/** GitHub 源:原生 updater 通道,带签名校验与全自动下载安装 */
async function checkGithubSource(): Promise<void> {
  const update = await checkGithubUpdate();
  if (!update) return;

  toast.show({
    kind: 'info',
    message: `RocketX ${update.version} 已发布`,
    duration: 0,
    action: {
      label: '更新并重启',
      onClick: () => {
        void (async () => {
          const freshUpdate = await checkGithubUpdate();
          if (!freshUpdate) return;
          const toastId = toast.loading(`正在下载 RocketX ${freshUpdate.version}…`);
          try {
            await freshUpdate.downloadAndInstall((event) => {
              if (event.event === 'Finished') {
                toast.update(toastId, { kind: 'success', message: '更新已安装，正在重启…' });
              }
            });
            const { relaunch } = await import('@tauri-apps/plugin-process');
            await relaunch();
          } catch (error) {
            toast.update(toastId, { kind: 'error', message: humanError(error, '自动更新失败') });
          }
        })().catch((error) => toast.error(error, '自动更新失败'));
      },
    },
  });
}

/** 自定义源(内网 HTTP / 共享目录):检测提醒 + 引导安装(issue #106) */
async function checkCustomSource(): Promise<void> {
  const config = loadUpdateSource();
  if (config.kind === 'http') {
    const update = await checkHttpUpdate(config.location);
    if (!update) return;
    toast.show({
      kind: 'info',
      message: `RocketX ${update.version} 已发布（签名内网源）`,
      duration: 0,
      action: {
        label: '更新并重启',
        onClick: () => {
          void (async () => {
            const freshUpdate = await checkHttpUpdate(config.location);
            if (!freshUpdate) return;
            const toastId = toast.loading(`正在下载并验证 RocketX ${freshUpdate.version}…`);
            try {
              await freshUpdate.downloadAndInstall();
              toast.update(toastId, { kind: 'success', message: '更新已安装，正在重启…' });
              const { relaunch } = await import('@tauri-apps/plugin-process');
              await relaunch();
            } catch (error) {
              toast.update(toastId, { kind: 'error', message: humanError(error, '自动更新失败') });
            }
          })().catch((error) => toast.error(error, '自动更新失败'));
        },
      },
    });
    return;
  }
  const probe = await probeConfiguredSource(config, __APP_VERSION__);
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
    if (!isTauri || checked) return;
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
    void (config.kind === 'github' ? checkGithubSource() : checkCustomSource()).catch((error) => {
      // 默认 GitHub 源离线时不打扰；用户显式配置的内网源失败必须可见，避免长期误以为在自动更新。
      if (config.kind !== 'github') toast.error(error, '自定义更新源检查失败');
    });
  }, []);

  return null;
}
