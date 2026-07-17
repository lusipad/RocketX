const DEVICE_ID_KEY = 'rcx-agent-device-id';

let fallbackId: string | null = null;

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  fallbackId ??= `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return fallbackId;
}

export function agentDeviceId(): string {
  try {
    const current = localStorage.getItem(DEVICE_ID_KEY);
    if (current) return current;
    const created = newId();
    localStorage.setItem(DEVICE_ID_KEY, created);
    return created;
  } catch {
    return newId();
  }
}
