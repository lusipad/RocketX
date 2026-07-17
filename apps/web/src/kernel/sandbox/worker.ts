const BLOCKED_GLOBALS = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'WebSocketStream',
  'WebTransport',
  'EventSource',
  'Worker',
  'SharedWorker',
  'RTCPeerConnection',
  'webkitRTCPeerConnection',
  'indexedDB',
  'caches',
  'importScripts',
];

export function createSandboxedWorker(source: string, name = 'rcx-app-worker'): Worker {
  const guards = BLOCKED_GLOBALS.map(
    (key) => `try { Object.defineProperty(globalThis, ${JSON.stringify(key)}, { value: undefined, configurable: false, writable: false }); } catch {}`,
  ).join('\n');
  const blob = new Blob([`"use strict";\n${guards}\n${source}`], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url, { name });
  URL.revokeObjectURL(url);
  return worker;
}
