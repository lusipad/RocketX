import { useEffect } from 'react';
import { isTauri } from '../lib/http';
import {
  checkSignedHttpSource,
  launchDirInstaller,
  loadUpdateSource,
  probeConfiguredSource,
} from '../lib/updateSource';
import { toast } from '../stores/toast';

declare const __APP_VERSION__: string;

let checked = false;

/** GitHub 源:原生 updater 通道,带签名校验与全自动下载安装 */
async function checkGithubSource(): Promise<void> {
  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check({ timeout: 15_000 });
  if (!update) return;

  toast.show({
    kind: 'info',
    message: `RocketX ${update.version} 已发布`,
    duration: 0,
    action: {
      label: '更新并重启',
      onClick: () => {
        const toastId = toast.loading(`正在下载 RocketX ${update.version}…`);
        void update
          .downloadAndInstall((event) => {
            if (event.event === 'Finished') {
              toast.update(toastId, { kind: 'success', message: '更新已安装，正在重启…' });
            }
          })
          .then(async () => {
            const { relaunch } = await import('@tauri-apps/plugin-process');
            await relaunch();
          })
          .catch((error) => toast.update(toastId, { kind: 'error', message: String(error) }));
      },
    },
  });
}

/** 自定义源(内网 HTTP / 共享目录):检测提醒 + 引导安装(issue #106) */
async function checkCustomSource(): Promise<void> {
  const config = loadUpdateSource();
  if (config.kind === 'http') {
    const update = await checkSignedHttpSource(config.location);
    if (!update) return;
    toast.show({
      kind: 'info',
      message: `RocketX ${update.version} 已发布（签名内网源）`,
      duration: 0,
      action: {
        label: '更新并重启',
        onClick: () => {
          const toastId = toast.loading(`正在下载并验证 RocketX ${update.version}…`);
          void update.downloadAndInstall()
            .then(async () => {
              toast.update(toastId, { kind: 'success', message: '更新已安装，正在重启…' });
              const { relaunch } = await import('@tauri-apps/plugin-process');
              await relaunch();
            })
            .catch((error) => toast.update(toastId, { kind: 'error', message: String(error) }));
        },
      },
    });
    return;
  }
  const probe = await probeConfiguredSource(config, __APP_VERSION__);
  if (!probe.hasUpdate) return;

  const action = probe.installerPath
    ? {
        label: '安装更新',
        onClick: () => {
          void launchDirInstaller(config.location, probe.installerPath!, probe.signature!)
            .then(() => toast.info('安装包已启动，请按安装向导完成更新'))
            .catch((error) => toast.error(error, '启动安装包失败'));
        },
      }
    : undefined;

  toast.show({
    kind: 'info',
    message: `RocketX ${probe.version} 已发布（来自自定义更新源）`,
    duration: 0,
    ...(action ? { action } : {}),
  });
}

export default function UpdaterBridge() {
  useEffect(() => {
    if (!isTauri || checked) return;
    checked = true;

    const config = loadUpdateSource();
    void (config.kind === 'github' ? checkGithubSource() : checkCustomSource()).catch((error) => {
      // 默认 GitHub 源离线时不打扰；用户显式配置的内网源失败必须可见，避免长期误以为在自动更新。
      if (config.kind !== 'github') toast.error(error, '自定义更新源检查失败');
    });
  }, []);

  return null;
}
