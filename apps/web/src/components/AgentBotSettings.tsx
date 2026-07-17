import { invoke } from '@tauri-apps/api/core';
import { Bot, Loader2, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getServerBase, isTauri } from '../lib/client';
import { toast } from '../stores/toast';

interface BotStatus {
  enabled: boolean;
  serverUrl?: string;
  userId?: string;
  username?: string;
}

const inputCls =
  'h-9 w-full rounded-md border border-line bg-surface px-3 text-sm outline-none transition focus:border-primary';

export default function AgentBotSettings() {
  const [status, setStatus] = useState<BotStatus>({ enabled: false });
  const [userId, setUserId] = useState('');
  const [username, setUsername] = useState('codex');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    if (!isTauri) {
      setBusy(false);
      return;
    }
    invoke<BotStatus>('agent_bot_config_status')
      .then((value) => {
        setStatus(value);
        setUserId(value.userId ?? '');
        setUsername(value.username ?? 'codex');
      })
      .catch((error) => toast.error(error, '读取 Agent Bot 配置失败'))
      .finally(() => setBusy(false));
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      if (!token.trim()) throw new Error('请输入 Bot auth token');
      await invoke('agent_bot_config_set', {
        serverUrl: getServerBase(),
        userId: userId.trim(),
        username: username.trim(),
        authToken: token.trim(),
      });
      setStatus({ enabled: true, serverUrl: getServerBase(), userId: userId.trim(), username: username.trim() });
      setToken('');
      toast.success('Agent Bot 已保存到系统凭据库');
    } catch (error) {
      toast.error(error, '保存 Agent Bot 失败');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await invoke('agent_bot_config_delete');
      setStatus({ enabled: false });
      setToken('');
      toast.success('Agent Bot 已删除，后续回复由宿主账号代发');
    } catch (error) {
      toast.error(error, '删除 Agent Bot 失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-ink">共享 Agent 身份</h2>
      <div className="rounded-lg border border-line bg-surface p-4">
        <div className="flex items-start gap-3">
          <div className="rounded-md bg-primary-light p-2 text-primary"><Bot size={17} /></div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ink">
              {status.enabled ? `Bot @${status.username}` : '未配置 Bot，使用宿主账号代发'}
            </div>
            <div className="mt-1 text-xs leading-5 text-ink-3">
              推荐由管理员创建专用 Bot 账号。Bot token 只进系统凭据库；状态卡和审批权限仍属于宿主。
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="Bot 用户名，如 codex"
                className={inputCls}
              />
              <input
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
                placeholder="Bot userId"
                className={inputCls}
              />
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder={status.enabled ? '输入新 token 以替换' : 'Bot auth token'}
                autoComplete="new-password"
                className={`${inputCls} sm:col-span-2`}
              />
            </div>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => void save()}
                disabled={!isTauri || busy}
                className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm text-white disabled:opacity-50"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Bot size={14} />}
                {status.enabled ? '替换 Bot 凭据' : '保存 Bot'}
              </button>
              {status.enabled ? (
                <button
                  onClick={() => void remove()}
                  disabled={busy}
                  className="flex h-8 items-center gap-1.5 rounded-md border border-line px-3 text-sm text-ink-2 disabled:opacity-50"
                >
                  <Trash2 size={14} /> 删除
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
