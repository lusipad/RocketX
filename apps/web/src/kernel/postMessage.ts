import { useChat } from '../stores/chat';

/**
 * App 桥 chat.postMessage 的发送实现。
 * 长度上限与输入框统一：不再用固定 20k 字符上限整条拒绝，而是交给 chat.send
 * 按服务端 Message_MaxAllowedSize 自动分段顺序发送（issue #349 的
 * toSendableMessageChunks + getPublicSetting 路径），超长文本不再被误拒。
 * capability 层只保留入参校验：未加入会话 / 空文本仍报错。
 */
export async function postBridgeMessage(
  rid: string,
  text: string,
  tmid?: string,
): Promise<{ ok: true }> {
  const chat = useChat.getState();
  if (!rid || !chat.subscriptions[rid]) throw new Error('只能向已加入的会话发送消息');
  if (!text.trim()) throw new Error('消息不能为空');
  await chat.send(text, { rid, ...(tmid ? { tmid } : {}) });
  return { ok: true };
}
