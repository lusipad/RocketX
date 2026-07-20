import { useEffect, useMemo, useState } from 'react';
import { Download, File as FileIcon, Loader2, Paperclip, Radio, Send } from 'lucide-react';
import { fmtSize, fmtTime } from '../lib/format';
import { isTauri } from '../lib/client';
import { useIpmsg, type IpmsgMessage } from '../ipmsg/store';
import { toast } from '../stores/toast';

function FileCard({ message }: { message: IpmsgMessage }) {
  const downloadFile = useIpmsg((state) => state.downloadFile);
  const [busy, setBusy] = useState(false);

  const act = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (message.localPath) {
        const { openPath } = await import('@tauri-apps/plugin-opener');
        await openPath(message.localPath);
      } else {
        await downloadFile(message.id);
      }
    } catch (error) {
      toast.error(error, '内网通文件操作失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 flex w-64 items-center gap-3 rounded-lg border border-line bg-surface-4 p-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-light text-primary">
        <FileIcon size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">{message.fileName}</span>
        <span className="block text-xs text-ink-3">
          {message.expired
            ? '邀请已过期'
            : message.localPath
              ? `${fmtSize(message.fileSize)} · 已下载`
              : `${fmtSize(message.fileSize)} · 等待接收`}
        </span>
      </span>
      {!message.expired && message.direction === 'incoming' && (
        <button
          onClick={() => void act()}
          disabled={busy}
          title={message.localPath ? '打开本地文件' : '下载'}
          className="flex h-8 w-8 items-center justify-center rounded text-ink-3 hover:bg-fill-hover hover:text-primary disabled:opacity-50"
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
        </button>
      )}
    </div>
  );
}

export default function IpmsgChatArea() {
  const running = useIpmsg((state) => state.running);
  const intranetAvailable = useIpmsg((state) => state.intranetAvailable);
  const error = useIpmsg((state) => state.error);
  const peers = useIpmsg((state) => state.peers);
  const selectedPeerId = useIpmsg((state) => state.selectedPeerId);
  const messages = useIpmsg((state) => state.messages);
  const selectPeer = useIpmsg((state) => state.selectPeer);
  const sendMessage = useIpmsg((state) => state.sendMessage);
  const offerFile = useIpmsg((state) => state.offerFile);
  const markRead = useIpmsg((state) => state.markRead);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => markRead(), [markRead, messages.length]);
  const selectedPeer = useMemo(
    () => peers.find((peer) => peer.id === selectedPeerId),
    [peers, selectedPeerId],
  );

  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      await sendMessage(text);
      setText('');
    } catch (sendError) {
      toast.error(sendError, '内网通消息发送失败');
    } finally {
      setSending(false);
    }
  };

  const chooseFile = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const path = await open({ multiple: false, directory: false, title: '选择要发送的文件' });
      if (typeof path === 'string') await offerFile(path);
    } catch (fileError) {
      toast.error(fileError, '内网通文件发送失败');
    }
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface-3">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-light text-primary">
            <Radio size={18} />
          </span>
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-ink">内网通兼容频道</div>
            <div className="truncate text-xs text-ink-3">
              {running
                ? intranetAvailable
                  ? `${peers.length} 个在线联系人 · 正在监听 2425/9011 · 未认证旧协议`
                  : `${peers.length} 个在线联系人 · 正在监听 2425；9011 被占用，内网通兼容不可用`
                : error || '内网通兼容模式未启动'}
            </div>
          </div>
        </div>
        <select
          value={selectedPeerId ?? ''}
          onChange={(event) => selectPeer(event.target.value)}
          disabled={!running || peers.length === 0}
          className="ipmsg-peer-select h-8 max-w-64 rounded-md border border-line bg-surface px-2 text-sm text-ink disabled:opacity-50"
        >
          <option value="">{peers.length ? '选择联系人' : '没有在线联系人'}</option>
          {peers.map((peer) => (
            <option key={peer.id} value={peer.id}>
              {peer.nickname || peer.user} · {peer.ip} ({peer.dialect})
            </option>
          ))}
        </select>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-3xl space-y-3">
          <div className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-xs leading-5 text-warning">
            此频道使用无身份认证的 内网通 / 飞鸽 / 飞秋旧协议。请只与可信局域网设备通信；收到的文件不会自动下载或打开。
          </div>
          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${message.direction === 'outgoing' ? 'justify-end' : 'justify-start'}`}
            >
              <div className={`max-w-[72%] rounded-xl px-3.5 py-2.5 ${
                message.direction === 'outgoing' ? 'bg-primary text-white' : 'bg-surface border border-line text-ink'
              }`}>
                <div className={`mb-1 text-xs ${message.direction === 'outgoing' ? 'text-white/70' : 'text-ink-3'}`}>
                  {message.senderName} · {fmtTime(message.timestamp)}
                </div>
                <div className="whitespace-pre-wrap break-words text-sm">{message.text}</div>
                {message.fileName && <FileCard message={message} />}
                {message.direction === 'outgoing' && message.acknowledged === false && (
                  <div className="mt-1 text-xs text-white/70">对方未确认收到</div>
                )}
              </div>
            </div>
          ))}
          {messages.length === 0 && (
            <div className="py-16 text-center text-sm text-ink-3">发现内网通、飞鸽或飞秋联系人后即可发送消息或文件。</div>
          )}
        </div>
      </div>

      <div className="border-t border-line bg-surface px-4 py-3">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <button
            onClick={() => void chooseFile()}
            disabled={!isTauri || !selectedPeer}
            title="发送文件"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-fill-hover hover:text-primary disabled:opacity-40"
          >
            <Paperclip size={18} />
          </button>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            disabled={!selectedPeer}
            placeholder={selectedPeer ? `发送给 ${selectedPeer.nickname || selectedPeer.user}` : '请先选择在线联系人'}
            rows={1}
            className="min-h-9 flex-1 resize-none rounded-lg border border-line bg-surface-3 px-3 py-2 text-sm text-ink outline-none focus:border-primary disabled:opacity-50"
          />
          <button
            onClick={() => void send()}
            disabled={!selectedPeer || !text.trim() || sending}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary text-white hover:bg-primary-hover disabled:opacity-40"
          >
            {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </button>
        </div>
      </div>
    </main>
  );
}
