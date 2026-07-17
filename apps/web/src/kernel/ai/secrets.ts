import { isTauri } from '../../lib/http';

const sessionSecrets = new Map<string, string>();

function validateProviderId(providerId: string): string {
  const value = providerId.trim();
  if (!value || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('AI Provider ID 无效');
  }
  return value;
}

export async function setAiSecret(providerId: string, secret: string): Promise<void> {
  const id = validateProviderId(providerId);
  if (!secret || secret.length > 64 * 1024) throw new Error('AI 密钥为空或过长');
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('ai_secret_set', { providerId: id, secret });
    return;
  }
  sessionSecrets.set(id, secret);
}

export async function getAiSecret(providerId: string): Promise<string | undefined> {
  const id = validateProviderId(providerId);
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    return (await invoke<string | null>('ai_secret_get', { providerId: id })) ?? undefined;
  }
  return sessionSecrets.get(id);
}

export async function deleteAiSecret(providerId: string): Promise<void> {
  const id = validateProviderId(providerId);
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('ai_secret_delete', { providerId: id });
    return;
  }
  sessionSecrets.delete(id);
}
