import {
  Code2,
  Copy,
  ExternalLink,
  Eye,
  FileText,
  FolderOpen,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n';
import {
  sandboxArtifactHtml,
  type CodexArtifact,
} from '../lib/codexArtifacts';
import { isTauriRuntime } from '../lib/client';
import { renderMarkdownDoc } from '../lib/markdown';
import { useCodexWorkspace } from '../stores/codexWorkspace';
import { toast } from '../stores/toast';
import ContextMenu from './ContextMenu';
import PdfView from './PdfView';

const MAX_PREVIEW_BYTES = 12 * 1024 * 1024;

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function CodexArtifactLink({
  artifact,
  label,
  onOpen,
}: {
  artifact: CodexArtifact;
  label: string;
  onOpen: (artifact: CodexArtifact) => void;
}) {
  const t = useT();
  const openArtifact = useCodexWorkspace((state) => state.openArtifact);
  const revealArtifact = useCodexWorkspace((state) => state.revealArtifact);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const copyPath = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(artifact.path);
      toast.success(t('agent.artifact.copiedPath'));
    } catch (reason) {
      toast.error(reason, t('agent.artifact.copyPathError'));
    }
  };

  const openPath = async (): Promise<void> => {
    try {
      await openArtifact(artifact.path);
    } catch (reason) {
      toast.error(reason, t('agent.artifact.openError'));
    }
  };

  const revealPath = async (): Promise<void> => {
    try {
      await revealArtifact(artifact.path);
    } catch (reason) {
      toast.error(reason, t('agent.artifact.revealError'));
    }
  };

  return (
    <>
      <button
        type="button"
        className="codex-artifact-link"
        title={t('agent.artifact.cardTitle', { path: artifact.path })}
        onClick={() => onOpen(artifact)}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <FileText size={14} aria-hidden="true" />
        <span>{label || artifact.name}</span>
        <Eye size={13} aria-hidden="true" />
      </button>
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: t('agent.artifact.previewInPage'), icon: Eye, onClick: () => onOpen(artifact) },
            {
              label: artifact.kind === 'html' ? t('agent.artifact.openInBrowser') : t('agent.artifact.openInSystemApp'),
              icon: ExternalLink,
              onClick: () => void openPath(),
            },
            { label: t('agent.artifact.showInFolder'), icon: FolderOpen, onClick: () => void revealPath() },
            { label: t('agent.artifact.copyFilePath'), icon: Copy, onClick: () => void copyPath() },
          ]}
        />
      ) : null}
    </>
  );
}

export default function CodexArtifactPanel({
  artifact,
  onClose,
}: {
  artifact: CodexArtifact;
  onClose: () => void;
}) {
  const readFile = useCodexWorkspace((state) => state.readFile);
  const t = useT();
  const openArtifact = useCodexWorkspace((state) => state.openArtifact);
  const revealArtifact = useCodexWorkspace((state) => state.revealArtifact);
  const [dataBase64, setDataBase64] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState<'preview' | 'source'>('preview');

  useEffect(() => {
    setView('preview');
  }, [artifact.path]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [onClose]);

  useEffect(() => {
    let active = true;
    setDataBase64(null);
    setError(null);
    if (!isTauriRuntime()) {
      setError(t('agent.artifact.webUnsupported'));
      return () => { active = false; };
    }
    void readFile(artifact.path)
      .then((data) => {
        if (!active) return;
        if (Math.floor(data.length * 0.75) > MAX_PREVIEW_BYTES) {
          setError(t('agent.artifact.fileTooLarge'));
          return;
        }
        setDataBase64(data);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => { active = false; };
  }, [artifact.path, readFile, revision]);

  const bytes = useMemo(() => dataBase64 ? bytesFromBase64(dataBase64) : null, [dataBase64]);
  const text = useMemo(() => bytes && ['html', 'markdown', 'text'].includes(artifact.kind)
    ? new TextDecoder().decode(bytes)
    : null, [artifact.kind, bytes]);
  const showViewToggle = artifact.kind === 'html' || artifact.kind === 'markdown';

  const copyPath = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(artifact.path);
      toast.success(t('agent.artifact.copiedPath'));
    } catch (reason) {
      toast.error(reason, t('agent.artifact.copyPathError'));
    }
  };

  const openPath = async (): Promise<void> => {
    try {
      await openArtifact(artifact.path);
    } catch (reason) {
      toast.error(reason, t('agent.artifact.openError'));
    }
  };

  const revealPath = async (): Promise<void> => {
    try {
      await revealArtifact(artifact.path);
    } catch (reason) {
      toast.error(reason, t('agent.artifact.revealError'));
    }
  };

  const openLabel = artifact.kind === 'html' ? t('agent.artifact.openInBrowser') : t('agent.artifact.openInSystemApp');

  return (
    <aside className="codex-artifact-panel" aria-label={`Artifact ${artifact.name}`}>
      <header>
        <div>
          <FileText size={16} aria-hidden="true" />
          <span>
            <strong>{artifact.name}</strong>
            <small title={artifact.path}>{artifact.path}</small>
          </span>
        </div>
        <div className="codex-artifact-actions">
          <button type="button" title={t('common.refresh')} aria-label={t('agent.artifact.refreshAria')} onClick={() => setRevision((value) => value + 1)}>
            <RefreshCw size={15} aria-hidden="true" />
          </button>
          <button type="button" title={t('agent.artifact.copyPathBtnTitle')} aria-label={t('agent.artifact.copyPathAria')} onClick={() => void copyPath()}>
            <Copy size={15} aria-hidden="true" />
          </button>
          <button type="button" title={t('agent.artifact.revealLocationTitle')} aria-label={t('agent.artifact.revealLocationAria')} disabled={!isTauriRuntime()} onClick={() => void revealPath()}>
            <FolderOpen size={15} aria-hidden="true" />
          </button>
          <button type="button" title={openLabel} aria-label={`${openLabel} Artifact`} disabled={!isTauriRuntime()} onClick={() => void openPath()}>
            <ExternalLink size={15} aria-hidden="true" />
          </button>
          <button type="button" title={t('common.close')} aria-label={t('agent.artifact.closeAria')} onClick={onClose}>
            <X size={17} aria-hidden="true" />
          </button>
        </div>
      </header>

      {showViewToggle ? (
        <nav aria-label={t('agent.artifact.viewModeAria')}>
          <button type="button" aria-current={view === 'preview' ? 'page' : undefined} onClick={() => setView('preview')}>
            <Eye size={14} aria-hidden="true" />{t('agent.artifact.tabPreview')}
          </button>
          <button type="button" aria-current={view === 'source' ? 'page' : undefined} onClick={() => setView('source')}>
            <Code2 size={14} aria-hidden="true" />{t('agent.artifact.tabSource')}
          </button>
        </nav>
      ) : null}

      <div className="codex-artifact-stage">
        {!dataBase64 && !error ? (
          <div className="codex-artifact-state"><Loader2 size={18} className="animate-spin motion-reduce:animate-none" />{t('agent.artifact.loading')}</div>
        ) : null}
        {error ? (
          <div className="codex-artifact-state is-error">
            <FileText size={22} aria-hidden="true" />
            <strong>{t('agent.artifact.previewUnavailable')}</strong>
            <span>{error}</span>
            {isTauriRuntime() ? <button type="button" onClick={() => void openPath()}>{openLabel}</button> : null}
          </div>
        ) : null}
        {bytes && artifact.kind === 'html' && text !== null && view === 'preview' ? (
          <iframe
            title={t('agent.artifact.iframeTitle', { name: artifact.name })}
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={sandboxArtifactHtml(text)}
          />
        ) : null}
        {bytes && artifact.kind === 'markdown' && text !== null && view === 'preview' ? (
          <article className="codex-artifact-document">{renderMarkdownDoc(text)}</article>
        ) : null}
        {bytes && (artifact.kind === 'text' || view === 'source') && text !== null ? (
          <pre className="codex-artifact-source">{text}</pre>
        ) : null}
        {bytes && artifact.kind === 'image' ? (
          <div className="codex-artifact-image"><img src={`data:${artifact.mimeType};base64,${dataBase64}`} alt={artifact.name} /></div>
        ) : null}
        {bytes && artifact.kind === 'pdf' ? <PdfView data={arrayBuffer(bytes)} /> : null}
        {bytes && artifact.kind === 'file' ? (
          <div className="codex-artifact-state">
            <FileText size={22} aria-hidden="true" />
            <strong>{t('agent.artifact.formatUnsupported')}</strong>
            <span>{artifact.name}</span>
            <button type="button" onClick={() => void openPath()}>{openLabel}</button>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
