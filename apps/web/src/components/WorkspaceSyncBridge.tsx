import { useEffect, useState } from 'react';
import {
  loadWorkspaceSource,
  pendingWorkspaceFields,
  planWorkspaceFields,
  saveWorkspaceSource,
  shouldCheckWorkspaceSync,
  WORKSPACE_SOURCE_CHANGED_EVENT,
  type WorkspaceConfig,
} from '../lib/workspaceConfig';
import { fetchWorkspaceConfig } from '../lib/workspaceConfigSource';
import { toast } from '../stores/toast';
import { collectCurrentValues, ImportPreviewDialog } from './WorkspaceConfigImport';

const SYNC_POLL_MS = 5 * 60 * 1000;

/**
 * 团队配置跟随更新（提案 §4）：URL 导入过工作区配置后，每天自动拉一次,
 * 有「会被默认勾选」的变化(排除本地一致与用户覆盖)时提醒;点「查看」
 * 弹出与手动导入完全相同的字段预览——**永不静默改配置**。
 */
export default function WorkspaceSyncBridge() {
  const [preview, setPreview] = useState<{ config: WorkspaceConfig; sourceUrl: string } | null>(null);

  useEffect(() => {
    let checking = false;
    let disposed = false;
    const checkNow = async () => {
      const source = loadWorkspaceSource();
      if (checking || !shouldCheckWorkspaceSync(source)) return;
      checking = true;
      const url = source!.url!;
      try {
        const config = await fetchWorkspaceConfig(url);
        const latest = loadWorkspaceSource();
        if (latest?.url === url) saveWorkspaceSource({ ...latest, lastCheckedAt: Date.now() });
        const fields = planWorkspaceFields(
          config,
          collectCurrentValues(),
          loadWorkspaceSource()?.applied ?? {},
        );
        const pending = pendingWorkspaceFields(fields);
        if (disposed || pending.length === 0) return;
        toast.show({
          kind: 'info',
          message: `团队配置有更新：${pending.length} 项变化(${config.name || '工作区配置'})`,
          duration: 0,
          action: {
            label: '查看',
            onClick: () => setPreview({ config, sourceUrl: url }),
          },
        });
      } catch (error) {
        const latest = loadWorkspaceSource();
        if (latest?.url === url) saveWorkspaceSource({ ...latest, lastCheckedAt: Date.now() });
        if (!disposed) toast.error(error, '团队配置自动检查失败');
      } finally {
        checking = false;
      }
    };

    const onSourceChanged = () => void checkNow();
    window.addEventListener(WORKSPACE_SOURCE_CHANGED_EVENT, onSourceChanged);
    const timer = window.setInterval(() => void checkNow(), SYNC_POLL_MS);
    void checkNow();
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener(WORKSPACE_SOURCE_CHANGED_EVENT, onSourceChanged);
    };
  }, []);

  if (!preview) return null;
  return (
    <ImportPreviewDialog
      config={preview.config}
      sourceUrl={preview.sourceUrl}
      onApplied={() => undefined}
      onClose={() => setPreview(null)}
    />
  );
}
