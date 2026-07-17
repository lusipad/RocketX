import { useEffect, useMemo, useRef } from 'react';
import type { RcxAppManifest } from '../manifest';
import type { BridgeHost } from '../bridge';

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

export function sandboxDocument(manifest: RcxAppManifest, html: string): string {
  const entry = typeof manifest.entry === 'string' ? manifest.entry : '';
  const entryUrl = /^https?:\/\//i.test(entry) ? new URL(entry) : null;
  const assetOrigin = entryUrl?.origin;
  const csp = [
    "default-src 'none'",
    "script-src 'unsafe-inline' blob:",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    `base-uri ${assetOrigin || "'none'"}`,
    "form-action 'none'",
  ].join('; ');
  const base = entryUrl ? `<base href="${escapeAttribute(entryUrl.href)}">` : '';
  const bridgeBootstrap = `<script>(()=>{let port;const queue=[];const listeners=new Set();const bridge=Object.freeze({postMessage(message){port?port.postMessage(message):queue.push(message)},addEventListener(type,listener){if(type==='message')listeners.add(listener)},removeEventListener(type,listener){if(type==='message')listeners.delete(listener)}});Object.defineProperty(window,'__RCX_BRIDGE__',{value:bridge});window.addEventListener('message',event=>{if(port||event.source!==parent||event.data?.method!=='rcx/connect'||!event.ports[0])return;port=event.ports[0];port.addEventListener('message',message=>{for(const listener of listeners)listener(message)});port.start();for(const message of queue.splice(0))port.postMessage(message)})})()</script>`;
  const policy = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">${base}${bridgeBootstrap}`;
  return /<head(?:\s[^>]*)?>/i.test(html)
    ? html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${policy}`)
    : `<!doctype html><html><head>${policy}</head><body>${html}</body></html>`;
}

export default function IframeSandbox({
  appId,
  manifest,
  html,
  bridge,
  title = manifest.name,
}: {
  appId: string;
  manifest: RcxAppManifest;
  html: string;
  bridge: BridgeHost;
  title?: string;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const cleanup = useRef<(() => void) | undefined>();
  const connectedDocument = useRef<string | undefined>();
  const srcDoc = useMemo(() => sandboxDocument(manifest, html), [html, manifest]);
  const documentId = useMemo(() => crypto.randomUUID(), [appId, srcDoc]);

  useEffect(() => {
    return () => {
      cleanup.current?.();
      cleanup.current = undefined;
    };
  }, [documentId]);

  const handleLoad = () => {
    if (connectedDocument.current === documentId) {
      cleanup.current?.();
      cleanup.current = undefined;
      return;
    }
    const source = ref.current?.contentWindow;
    if (!source) return;
    cleanup.current?.();
    connectedDocument.current = documentId;
    cleanup.current = bridge.registerFrame(appId, manifest, source);
  };

  return (
    <iframe
      ref={ref}
      title={title}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      onLoad={handleLoad}
      referrerPolicy="no-referrer"
      className="h-full w-full border-0 bg-white"
    />
  );
}
