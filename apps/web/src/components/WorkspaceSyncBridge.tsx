import { useEffect, useState } from 'react';
import { httpFetch } from '../lib/client';
import {
  loadWorkspaceSource,
  parseWorkspaceConfig,
  pendingWorkspaceFields,
  planWorkspaceFields,
  saveWorkspaceSource,
  shouldCheckWorkspaceSync,
  type WorkspaceConfig,
} from '../lib/workspaceConfig';
import { toast } from '../stores/toast';
import { collectCurrentValues, ImportPreviewDialog } from './WorkspaceConfigImport';

/**
 * 团队配置跟随更新（提案 §4）：URL 导入过工作区配置后，每天自动拉一次,
 * 有「会被默认勾选」的变化(排除本地一致与用户覆盖)时提醒;点「查看」
 * 弹出与手动导入完全相同的字段预览——**永不静默改配置**。
 */
export default function WorkspaceSyncBridge() {
  const [preview, setPreview] = useState<{ config: WorkspaceConfig; sourceUrl: string } | null>(null);

  useEffect(() => {
    const source = loadWorkspaceSource();
    if (!shouldCheckWorkspaceSync(source)) return;
    const url = source!.url!;

    void (async () => {
      // 先记检查时间:失败也不在同一天里反复打服务器
      saveWorkspaceSource({ ...source!, lastCheckedAt: Date.now() });
      try {
        const res = await httpFetch(url);
        if (!res.ok) return;
        const config = parseWorkspaceConfig(await res.text());
        const fields = planWorkspaceFields(
          config,
          collectCurrentValues(),
          loadWorkspaceSource()?.applied ?? {},
        );
        const pending = pendingWorkspaceFields(fields);
        if (pending.length === 0) return;
        toast.show({
          kind: 'info',
          message: `团队配置有更新：${pending.length} 项变化(${config.name || '工作区配置'})`,
          duration: 0,
          action: {
            label: '查看',
            onClick: () => setPreview({ config, sourceUrl: url }),
          },
        });
      } catch {
        // 源暂时不可达或配置非法时保持安静,明天再试;手动「拉取」会给出具体错误
      }
    })();
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
