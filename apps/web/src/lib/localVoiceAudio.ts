export const LOCAL_VOICE_MAX_SECONDS = 30;
export const LOCAL_VOICE_MAX_RECORDING_BYTES = 4 * 1024 * 1024;
const SAMPLE_RATE = 16_000;

/** Native recognition accepts a short, mono PCM16 WAV; no browser speech service is used. */
export function encodeLocalVoiceWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const length = channels[0]?.length ?? 0;
  if (!length || !Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('录音为空，请重试。');
  if (channels.some((channel) => channel.length !== length)) throw new Error('录音音轨长度不一致，请重试。');
  if (length / sampleRate > LOCAL_VOICE_MAX_SECONDS + 0.25) throw new Error('单次录音最多 30 秒。');
  const outputLength = Math.min(Math.floor(length * SAMPLE_RATE / sampleRate), SAMPLE_RATE * LOCAL_VOICE_MAX_SECONDS);
  const wav = new ArrayBuffer(44 + outputLength * 2);
  const view = new DataView(wav);
  const label = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  label(0, 'RIFF'); view.setUint32(4, wav.byteLength - 8, true); label(8, 'WAVE');
  label(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, SAMPLE_RATE, true); view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); label(36, 'data'); view.setUint32(40, outputLength * 2, true);
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * sampleRate / SAMPLE_RATE;
    const left = Math.floor(position);
    const right = Math.min(left + 1, length - 1);
    const fraction = position - left;
    const mixed = channels.reduce((sum, channel) => sum + channel[left] * (1 - fraction) + channel[right] * fraction, 0) / channels.length;
    const sample = Math.max(-1, Math.min(1, mixed));
    view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return wav;
}

export function localVoiceBase64(bytes: ArrayBuffer): string {
  const data = new Uint8Array(bytes);
  let binary = '';
  for (let offset = 0; offset < data.length; offset += 8192) binary += String.fromCharCode(...data.subarray(offset, offset + 8192));
  return btoa(binary);
}

export function localVoiceError(reason: unknown): string {
  if (reason instanceof DOMException && (reason.name === 'NotAllowedError' || reason.name === 'SecurityError')) {
    return '麦克风权限未允许，请在系统隐私设置中允许 RocketX 使用麦克风后重试。';
  }
  if (reason instanceof DOMException && reason.name === 'NotFoundError') return '未找到麦克风，请连接设备后重试。';
  return reason instanceof Error ? reason.message : String(reason);
}
