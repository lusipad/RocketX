import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '../lib/http';

export interface LocalVoiceCapabilities {
  available: boolean;
  platform: string;
  recognizers: { id: string; language: string; name: string }[];
  voices: { id: string; language: string; name: string }[];
  reason?: string;
}

export async function probeLocalVoice(requestId: string): Promise<LocalVoiceCapabilities> {
  if (!isTauriRuntime()) return { available: false, platform: 'web', recognizers: [], voices: [], reason: '本地语音仅支持桌面客户端；浏览器不会连接云端语音。' };
  return invoke<LocalVoiceCapabilities>('local_voice_probe', { requestId });
}

export async function transcribeLocalVoice(audioBase64: string, requestId: string): Promise<{ text: string; language: string; durationMs: number }> {
  return invoke('local_voice_transcribe', { audioBase64, language: 'zh-CN', requestId });
}

export async function synthesizeLocalVoice(text: string, requestId: string, voiceId?: string): Promise<{ audioBase64: string; mimeType: string; language: string }> {
  return invoke('local_voice_synthesize', { text, voiceId, language: 'zh-CN', requestId });
}

export async function cancelLocalVoice(requestId: string): Promise<void> {
  await invoke('local_voice_cancel', { requestId });
}
