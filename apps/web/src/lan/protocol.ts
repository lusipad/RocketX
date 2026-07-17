export const LAN_KEY_PREFIX = '[RocketX-LAN-KEY:v1] ';

export interface LanDeviceKeyEnvelope {
  version: 1;
  userId: string;
  deviceId: string;
  deviceName: string;
  publicKey: string;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeLanDeviceKey(envelope: LanDeviceKeyEnvelope): string {
  return LAN_KEY_PREFIX + encodeBase64Url(new TextEncoder().encode(JSON.stringify(envelope)));
}

export function parseLanDeviceKey(text: string): LanDeviceKeyEnvelope | null {
  if (!text.startsWith(LAN_KEY_PREFIX) || text.length > 2048) return null;
  try {
    const parsed = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(text.slice(LAN_KEY_PREFIX.length))),
    ) as Partial<LanDeviceKeyEnvelope>;
    if (
      parsed.version !== 1 ||
      typeof parsed.userId !== 'string' ||
      !parsed.userId ||
      parsed.userId.length > 256 ||
      typeof parsed.deviceId !== 'string' ||
      !parsed.deviceId ||
      parsed.deviceId.length > 128 ||
      typeof parsed.deviceName !== 'string' ||
      !parsed.deviceName ||
      parsed.deviceName.length > 128 ||
      typeof parsed.publicKey !== 'string' ||
      parsed.publicKey.length < 40 ||
      parsed.publicKey.length > 128 ||
      [parsed.userId, parsed.deviceId, parsed.deviceName, parsed.publicKey].some((value) =>
        /[\u0000-\u001f\u007f]/.test(value),
      )
    ) {
      return null;
    }
    return parsed as LanDeviceKeyEnvelope;
  } catch {
    return null;
  }
}

export function isLanControlMessage(text: string): boolean {
  return text.startsWith(LAN_KEY_PREFIX);
}
