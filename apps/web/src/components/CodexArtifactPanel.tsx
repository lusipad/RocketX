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
  const openArtifact = useCodexWorkspace((state) => state.openArtifact);
  const revealArtifact = useCodexWorkspace((state) => state.revealArtifact);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const copyPath = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(artifact.path);
      toast.success('已复制文件路径');
    } catch (reason) {
      toast.error(reason, '无法复制文件路径');
    }
  };

  const openPath = async (): Promise<void> => {
    try {
      await openArtifact(artifact.path);
    } catch (reason) {
      toast.error(reason, '无法打开 Artifact');
    }
  };

  const revealPath = async (): Promise<void> => {
    try {
      await revealArtifact(artifact.path);
    } catch (reason) {
      toast.error(reason, '无法定位 Artifact');
    }
  };

  return (
    <>
      <button
        type="button"
        className="codex-artifact-link"
        title={`单击在页面中查看；右键显示更多操作：${artifact.path}`}
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
            { label: '在页面中预览', icon: Eye, onClick: () => onOpen(artifact) },
            {
              label: artifact.kind === 'html' ? '在浏览器中打开' : '使用系统应用打开',
              icon: ExternalLink,
              onClick: () => void openPath(),
            },
            { label: '在文件夹中显示', icon: FolderOpen, onClick: () => void revealPath() },
            { label: '复制文件路径', icon: Copy, onClick: () => void copyPath() },
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
      setError('网页版不能读取电脑上的本地文件，请在 RocketX 桌面端查看这个 Artifact。');
      return () => { active = false; };
    }
    void readFile(artifact.path)
      .then((data) => {
        if (!active) return;
        if (Math.floor(data.length * 0.75) > MAX_PREVIEW_BYTES) {
          setError('文件超过 12 MB，不在页面中加载；仍可使用“系统打开”。');
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
      toast.success('已复制文件路径');
    } catch (reason) {
      toast.error(reason, '无法复制文件路径');
    }
  };

  const openPath = async (): Promise<void> => {
    try {
      await openArtifact(artifact.path);
    } catch (reason) {
      toast.error(reason, '无法打开 Artifact');
    }
  };

  const revealPath = async (): Promise<void> => {
    try {
      await revealArtifact(artifact.path);
    } catch (reason) {
      toast.error(reason, '无法定位 Artifact');
    }
  };

  const openLabel = artifact.kind === 'html' ? '在浏览器中打开' : '使用系统应用打开';

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
          <button type="button" title="刷新" aria-label="刷新 Artifact" onClick={() => setRevision((value) => value + 1)}>
            <RefreshCw size={15} aria-hidden="true" />
          </button>
          <button type="button" title="复制路径" aria-label="复制 Artifact 路径" onClick={() => void copyPath()}>
            <Copy size={15} aria-hidden="true" />
          </button>
          <button type="button" title="打开所在位置" aria-label="打开 Artifact 所在位置" disabled={!isTauriRuntime()} onClick={() => void revealPath()}>
            <FolderOpen size={15} aria-hidden="true" />
          </button>
          <button type="button" title={openLabel} aria-label={`${openLabel} Artifact`} disabled={!isTauriRuntime()} onClick={() => void openPath()}>
            <ExternalLink size={15} aria-hidden="true" />
          </button>
          <button type="button" title="关闭" aria-label="关闭 Artifact" onClick={onClose}>
            <X size={17} aria-hidden="true" />
          </button>
        </div>
      </header>

      {showViewToggle ? (
        <nav aria-label="Artifact 查看方式">
          <button type="button" aria-current={view === 'preview' ? 'page' : undefined} onClick={() => setView('preview')}>
            <Eye size={14} aria-hidden="true" />预览
          </button>
          <button type="button" aria-current={view === 'source' ? 'page' : undefined} onClick={() => setView('source')}>
            <Code2 size={14} aria-hidden="true" />源码
          </button>
        </nav>
      ) : null}

      <div className="codex-artifact-stage">
        {!dataBase64 && !error ? (
          <div className="codex-artifact-state"><Loader2 size={18} className="animate-spin motion-reduce:animate-none" />正在读取 Artifact…</div>
        ) : null}
        {error ? (
          <div className="codex-artifact-state is-error">
            <FileText size={22} aria-hidden="true" />
            <strong>无法在页面中预览</strong>
            <span>{error}</span>
            {isTauriRuntime() ? <button type="button" onClick={() => void openPath()}>{openLabel}</button> : null}
          </div>
        ) : null}
        {bytes && artifact.kind === 'html' && text !== null && view === 'preview' ? (
          <iframe
            title={`预览 ${artifact.name}`}
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
            <strong>此格式不支持页内预览</strong>
            <span>{artifact.name}</span>
            <button type="button" onClick={() => void openPath()}>{openLabel}</button>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
