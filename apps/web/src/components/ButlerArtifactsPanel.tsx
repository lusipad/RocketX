import { Check, ChevronDown, FileText, GitCompare, ListChecks, PencilLine } from 'lucide-react';
import { useMemo, useState } from 'react';
import { renderMarkdown } from '../lib/markdown';
import {
  useButlerArtifacts,
  type ButlerArtifact,
  type ButlerArtifactKind,
} from '../stores/butlerArtifacts';

const kindMeta: Record<ButlerArtifactKind, { label: string; icon: typeof FileText }> = {
  report: { label: '报告', icon: FileText },
  draft: { label: '草稿', icon: PencilLine },
  diff: { label: '变更', icon: GitCompare },
  checklist: { label: '清单', icon: ListChecks },
};

export default function ButlerArtifactsPanel({
  artifacts,
  onContinue,
}: {
  artifacts: readonly ButlerArtifact[];
  onContinue: (title: string) => void;
}) {
  const accept = useButlerArtifacts((state) => state.accept);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [versionNumber, setVersionNumber] = useState<number | null>(null);
  const selected = artifacts.find((artifact) => artifact.id === selectedId) ?? artifacts[0];
  const version = useMemo(() => (
    selected?.versions.find((candidate) => candidate.number === versionNumber)
      ?? selected?.versions.at(-1)
  ), [selected, versionNumber]);

  if (!selected || !version) return null;
  const meta = kindMeta[selected.kind];
  const Icon = meta.icon;

  return (
    <section aria-label="管家成果" className="butler-artifacts">
      <header>
        <div>
          <span className="butler-eyebrow">需要继续加工时再来看</span>
          <h3>{artifacts.length} 份成果草稿</h3>
        </div>
        <label>
          <span className="sr-only">选择成果</span>
          <select
            value={selected.id}
            onChange={(event) => {
              setSelectedId(event.target.value);
              setVersionNumber(null);
            }}
          >
            {artifacts.map((artifact) => (
              <option key={artifact.id} value={artifact.id}>{artifact.title}</option>
            ))}
          </select>
          <ChevronDown size={13} aria-hidden="true" />
        </label>
      </header>
      <div className="butler-artifact-meta">
        <span><Icon size={13} />{meta.label}</span>
        <span>{selected.status === 'accepted' ? '已验收' : '待验收'}</span>
        <label>
          <span className="sr-only">查看成果版本</span>
          <select
            value={version.number}
            onChange={(event) => setVersionNumber(Number(event.target.value))}
          >
            {[...selected.versions].reverse().map((candidate) => (
              <option key={candidate.id} value={candidate.number}>v{candidate.number}</option>
            ))}
          </select>
        </label>
      </div>
      <article className="butler-artifact-content">{renderMarkdown(version.content)}</article>
      <footer>
        <span>{version.sources.length > 0 ? `${version.sources.length} 个来源` : '此版本没有附带来源'}</span>
        <div>
          <button type="button" onClick={() => onContinue(selected.title)}>继续编辑</button>
          <button
            type="button"
            disabled={selected.status === 'accepted'}
            onClick={() => accept(selected.id)}
          >
            <Check size={13} />
            {selected.status === 'accepted' ? '已验收' : '收下成果'}
          </button>
        </div>
      </footer>
    </section>
  );
}
