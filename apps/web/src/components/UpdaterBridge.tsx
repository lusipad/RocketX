import { useEffect } from 'react';
import { isTauri } from '../lib/http';
import { toast } from '../stores/toast';

let checked = false;

export default function UpdaterBridge() {
  useEffect(() => {
    if (!isTauri || checked) return;
    checked = true;

    void import('@tauri-apps/plugin-updater')
      .then(async ({ check }) => {
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
      })
      .catch(() => {
        // 离线或 Release 尚未提供 latest.json 时保持安静，下次启动再检查。
      });
  }, []);

  return null;
}
