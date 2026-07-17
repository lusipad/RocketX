import { invoke } from '@tauri-apps/api/core';
import type { RcMessage } from '@rcx/rc-client';
import { getServerBase, normalizeAssetPath, rest } from '../lib/client';
import { collectAgentAttachmentSources } from './context';

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const ROCKET_CHAT_FILE_PATH = /^\/(?:file-upload|ufs|file-decrypt)\//;

function safeSegment(value: string, fallback: string): string {
  const safe = value
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+$/, '_')
    .slice(0, 120);
  return safe || fallback;
}

export function agentAttachmentServerPath(rawPath: string, serverBase = getServerBase()): string | null {
  const path = normalizeAssetPath(rawPath);
  if (path.startsWith('/')) return ROCKET_CHAT_FILE_PATH.test(path) ? path : null;
  const server = serverBase.replace(/\/+$/, '');
  if (!server) return null;
  try {
    const target = new URL(path);
    const base = new URL(server);
    return target.origin === base.origin && ROCKET_CHAT_FILE_PATH.test(target.pathname) ? path : null;
  } catch {
    return null;
  }
}

export interface MaterializedAgentAttachments {
  paths: Record<string, string[]>;
  warnings: string[];
}

export async function materializeAgentAttachments(
  sessionId: string,
  messages: readonly RcMessage[],
): Promise<MaterializedAgentAttachments> {
  const paths: Record<string, string[]> = {};
  const warnings: string[] = [];
  let totalBytes = 0;
  const sources = collectAgentAttachmentSources(messages).slice(0, MAX_ATTACHMENTS);
  for (const [index, source] of sources.entries()) {
    const path = agentAttachmentServerPath(source.path);
    if (!path) {
      warnings.push(`附件 ${source.name} 不属于当前 Rocket.Chat 服务器，未自动读取`);
      continue;
    }
    try {
      const blob = await rest.fetchFile(path);
      if (blob.size > MAX_ATTACHMENT_BYTES || totalBytes + blob.size > MAX_TOTAL_BYTES) {
        warnings.push(`附件 ${source.name} 超过 Agent 上下文大小限制，未读取`);
        continue;
      }
      const relativePath = `${safeSegment(source.messageId, 'message')}/${index + 1}-${safeSegment(source.name, 'attachment')}`;
      const metadata = new TextEncoder().encode(JSON.stringify({ sessionId, relativePath }));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const request = new Uint8Array(4 + metadata.length + bytes.length);
      new DataView(request.buffer).setUint32(0, metadata.length, true);
      request.set(metadata, 4);
      request.set(bytes, 4 + metadata.length);
      const runtimePath = await invoke<string>('codex_agent_attachment_write', request);
      (paths[source.messageId] ??= []).push(runtimePath);
      totalBytes += blob.size;
    } catch (error) {
      warnings.push(
        `附件 ${source.name} 读取失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { paths, warnings };
}
