import { invoke } from '@tauri-apps/api/core';
import { Box, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { isTauri } from '../lib/http';
import { toast } from '../stores/toast';

interface RunnerStatus {
  dockerAvailable: boolean;
  imageReady: boolean;
  authenticated: boolean;
  version: string | null;
}

export default function AgentRunnerSettings() {
  const [status, setStatus] = useState<RunnerStatus>();
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    if (!isTauri) return;
    try {
      setStatus(await invoke<RunnerStatus>('codex_runner_status'));
    } catch (error) {
      toast.error(error, '读取 Agent Runner 状态失败');
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const install = async () => {
    setBusy(true);
    try {
      const next = await invoke<RunnerStatus>('codex_runner_install');
      setStatus(next);
      toast.success('隔离 Agent Runner 已安装');
    } catch (error) {
      toast.error(error, '安装 Agent Runner 失败');
    } finally {
      setBusy(false);
    }
  };

  if (!isTauri) return null;

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-ink">共享 Agent Runner</h2>
      <div className="rounded-lg border border-line bg-surface p-4 text-sm">
        <div className="flex items-start gap-3">
          <Box size={18} className="mt-0.5 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-ink">Docker 隔离执行</div>
            <p className="mt-1 leading-6 text-ink-2">
              每个共享 Agent 会话使用独立容器，只挂载所选工作区；`.env` 与 Codex 认证文件在工具沙箱中不可读。
            </p>
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              <span className={status?.dockerAvailable ? 'text-success' : 'text-danger'}>
                Docker：{status?.dockerAvailable ? '可用' : '未运行'}
              </span>
              <span className={status?.imageReady ? 'text-success' : 'text-warning'}>
                Runner：{status?.imageReady ? `已安装（Codex ${status.version}）` : '未安装'}
              </span>
              <span className={status?.authenticated ? 'text-success' : 'text-warning'}>
                Codex：{status?.authenticated ? '已登录' : '未登录'}
              </span>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => void install()}
                disabled={busy || !status?.dockerAvailable}
                className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Box size={14} />}
                {status?.imageReady ? '重新安装 Runner' : '安装 Runner'}
              </button>
              <button
                onClick={() => void refresh()}
                disabled={busy}
                className="flex h-8 items-center gap-1.5 rounded-md border border-line px-3 text-xs text-ink hover:bg-fill-hover disabled:opacity-50"
              >
                <RefreshCw size={14} /> 刷新状态
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
