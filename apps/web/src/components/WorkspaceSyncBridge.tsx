import { useEffect, useState } from 'react';
import { loadWorkbenchConfig } from '../lib/ado';
import {
  loadWorkspaceSource,
  pendingWorkspaceFields,
  planWorkspaceFields,
  saveWorkspaceSource,
  shouldCheckWorkspaceSync,
  workspaceSourceIdentity,
  workspaceSourceSnapshotKey,
  WORKSPACE_SOURCE_CHANGED_EVENT,
  type WorkspaceConfig,
  type WorkspaceSource,
} from '../lib/workspaceConfig';
import {
  fetchWorkspaceConfigFromSource,
  rebindAdoWorkspaceSource,
  remoteWorkspaceConfigSource,
  type WorkspaceConfigRemoteSource,
} from '../lib/workspaceConfigSource';
import { toast } from '../stores/toast';
import { collectCurrentValues, ImportPreviewDialog } from './WorkspaceConfigImport';

const SYNC_POLL_MS = 5 * 60 * 1000;

/**
 * 团队配置跟随更新（提案 §4）：URL / ADO 导入过工作区配置后，每天自动拉一次，
 * 有「会被默认勾选」的变化(排除本地一致与用户覆盖)时提醒;点「查看」
 * 弹出与手动导入完全相同的字段预览——**永不静默改配置**。
 */
export default function WorkspaceSyncBridge() {
  const [preview, setPreview] = useState<{ config: WorkspaceConfig; source: WorkspaceConfigRemoteSource } | null>(null);

  const markSourceChecked = (source: WorkspaceSource, remoteSource: WorkspaceConfigRemoteSource, checkedAt: number) => {
    if (source.kind === 'url' && remoteSource.kind === 'url') {
      saveWorkspaceSource({ ...source, url: remoteSource.url, lastCheckedAt: checkedAt });
      return;
    }
    if (source.kind === 'ado' && remoteSource.kind === 'ado') {
      saveWorkspaceSource({ ...source, ado: remoteSource.ado, lastCheckedAt: checkedAt });
      return;
    }
    if (source.kind === 'unc' && remoteSource.kind === 'unc') {
      saveWorkspaceSource({ ...source, path: remoteSource.path, lastCheckedAt: checkedAt });
      return;
    }
    saveWorkspaceSource({ ...source, lastCheckedAt: checkedAt });
  };

  useEffect(() => {
    let checking = false;
    let recheckRequested = false;
    let disposed = false;
    const checkNow = async () => {
      if (checking) {
        recheckRequested = true;
        return;
      }
      let source = loadWorkspaceSource();
      if (!source) return;
      let identityChanged = false;
      if (source.kind === 'ado') {
        const workbench = loadWorkbenchConfig();
        if (!workbench?.adoBase) return;
        const rebound = rebindAdoWorkspaceSource(source, workbench);
        identityChanged = workspaceSourceIdentity(rebound) !== workspaceSourceIdentity(source);
        if (identityChanged) source = rebound;
      }
      const remoteSource = remoteWorkspaceConfigSource(source);
      if (!remoteSource) return;
      const shouldCheck = shouldCheckWorkspaceSync(source);
      if (!identityChanged && !shouldCheck) return;
      checking = true;
      try {
        if (identityChanged) saveWorkspaceSource(source);
        if (!shouldCheck) return;
        const requestSnapshot = workspaceSourceSnapshotKey(source);
        try {
          const result = await fetchWorkspaceConfigFromSource(remoteSource);
          if (disposed) return;
          const latest = loadWorkspaceSource();
          if (!latest || workspaceSourceSnapshotKey(latest) !== requestSnapshot) return;
          markSourceChecked(latest, result.source, Date.now());
          const fields = planWorkspaceFields(result.config, collectCurrentValues(), latest.applied);
          const pending = pendingWorkspaceFields(fields);
          if (pending.length === 0) return;
          toast.show({
            kind: 'info',
            message: `团队配置有更新：${pending.length} 项变化(${result.config.name || '工作区配置'})`,
            duration: 0,
            action: {
              label: '查看',
              onClick: () => setPreview(result),
            },
          });
        } catch (error) {
          if (disposed) return;
          const latest = loadWorkspaceSource();
          if (!latest || workspaceSourceSnapshotKey(latest) !== requestSnapshot) return;
          saveWorkspaceSource({ ...latest, lastCheckedAt: Date.now() });
          toast.error(error, '团队配置自动检查失败');
        }
      } finally {
        checking = false;
        if (recheckRequested && !disposed) {
          recheckRequested = false;
          queueMicrotask(() => void checkNow());
        }
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
      source={preview.source}
      onApplied={() => undefined}
      onClose={() => setPreview(null)}
    />
  );
}
