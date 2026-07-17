import { invoke } from '@tauri-apps/api/core';
import { Check, Copy, Loader2, Unplug, Waypoints } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getServerBase, isTauri, loadStoredAuth } from '../lib/client';
import { toast } from '../stores/toast';

interface McpStatus {
  enabled: boolean;
  serverUrl?: string;
  userId?: string;
  command?: string;
}

export default function ReverseMcpSettings() {
  const [status, setStatus] = useState<McpStatus>({ enabled: false });
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    if (!isTauri) {
      setBusy(false);
      return;
    }
    invoke<McpStatus>('mcp_config_status')
      .then(setStatus)
      .catch((error) => toast.error(error, '读取反向 MCP 状态失败'))
      .finally(() => setBusy(false));
  }, []);

  const config = useMemo(
    () =>
      status.command
        ? JSON.stringify(
            { mcpServers: { rocketx: { command: status.command, args: ['--mcp'] } } },
            null,
            2,
          )
        : '',
    [status.command],
  );

  const toggle = async () => {
    setBusy(true);
    try {
      if (status.enabled) {
        await invoke('mcp_config_disable');
        setStatus((current) => ({ ...current, enabled: false, serverUrl: undefined, userId: undefined }));
        toast.success('反向 MCP 已停用，系统凭据已删除');
      } else {
        const auth = loadStoredAuth();
        const serverUrl = getServerBase();
        if (!auth || !serverUrl) throw new Error('需要先登录桌面端 Rocket.Chat');
        await invoke('mcp_config_enable', {
          serverUrl,
          userId: auth.userId,
          authToken: auth.authToken,
        });
        setStatus((current) => ({
          ...current,
          enabled: true,
          serverUrl,
          userId: auth.userId,
        }));
        toast.success('反向 MCP 已启用，Rocket.Chat token 仅保存在系统凭据库');
      }
    } catch (error) {
      toast.error(error, '更新反向 MCP 失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-ink">反向 MCP</h2>
      <div className="rounded-lg border border-line bg-surface p-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-md bg-primary-light p-2 text-primary">
            <Waypoints size={17} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-ink">让外部 Agent 读取聊天上下文</div>
                <div className="mt-1 text-xs leading-5 text-ink-3">
                  只暴露会话列表、房间历史和话题消息三个只读工具；访问范围等同当前 Rocket.Chat 账号。
                </div>
              </div>
              <button
                onClick={() => void toggle()}
                disabled={!isTauri || busy}
                className={`flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm ${
                  status.enabled
                    ? 'border border-line text-ink-2 hover:bg-fill-hover'
                    : 'bg-primary text-white hover:bg-primary-hover'
                } disabled:opacity-50`}
              >
                {busy ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : status.enabled ? (
                  <Unplug size={14} />
                ) : (
                  <Check size={14} />
                )}
                {status.enabled ? '停用' : '启用'}
              </button>
            </div>
            {status.enabled && config ? (
              <div className="mt-3">
                <div className="mb-1 flex items-center justify-between text-xs text-ink-3">
                  <span>外部 Agent 配置</span>
                  <button
                    onClick={() =>
                      void navigator.clipboard.writeText(config).then(() => toast.success('MCP 配置已复制'))
                    }
                    className="flex items-center gap-1 hover:text-primary"
                  >
                    <Copy size={12} /> 复制
                  </button>
                </div>
                <pre className="max-h-40 overflow-auto rounded bg-fill-1 p-3 text-xs text-ink-2">{config}</pre>
                <div className="mt-2 text-xs text-ink-3">
                  凭据不会出现在这段配置、命令行或环境变量中。
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
