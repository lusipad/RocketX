import {
  Check,
  FileUp,
  FilePenLine,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { useStore } from 'zustand';
import { toast } from '../../../../stores/toast';
import { useAuth } from '../../../../stores/auth';
import { useWorkbench, type Build, type PullRequest, type WorkItem } from '../../../../stores/workbench';
import type { ProfileFactKind } from '../model';
import { butlerProfile } from '../runtime';

const KIND_OPTIONS: Array<{ value: ProfileFactKind; label: string }> = [
  { value: 'identity', label: '身份' },
  { value: 'preference', label: '偏好' },
  { value: 'work-context', label: '工作背景' },
  { value: 'working-style', label: '工作方式' },
  { value: 'boundary', label: '边界' },
];

function factKindLabel(kind: ProfileFactKind): string {
  return KIND_OPTIONS.find((option) => option.value === kind)?.label ?? kind;
}

function currentProjectSummary(
  workItems: readonly WorkItem[],
  prs: readonly PullRequest[],
  builds: readonly Build[],
): string | null {
  const counts = new Map<string, number>();
  for (const project of [
    ...workItems.map((item) => item.project),
    ...prs.map((pr) => pr.project ?? ''),
    ...builds.map((build) => build.project),
  ]) {
    const name = project.trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-CN'))
    .slice(0, 3)
    .map(([name]) => name);
  return names.length ? names.join('、') : null;
}

function buildBootstrapEntries(input: {
  authName?: string;
  authUsername?: string;
  adoAccount?: string;
  adoBase?: string;
  workItems: readonly WorkItem[];
  prs: readonly PullRequest[];
  builds: readonly Build[];
}): Array<{ kind: ProfileFactKind; subject: string; value: string }> {
  const entries: Array<{ kind: ProfileFactKind; subject: string; value: string }> = [];
  const username = input.authUsername?.trim();
  const name = input.authName?.trim();
  if (username) {
    entries.push({
      kind: 'identity',
      subject: 'Rocket.Chat 身份',
      value: name && name !== username ? `${name}（@${username}）` : `@${username}`,
    });
  }
  if (input.adoAccount?.trim()) {
    entries.push({
      kind: 'work-context',
      subject: 'Azure DevOps 账号',
      value: input.adoAccount.trim(),
    });
  }
  if (input.adoBase?.trim()) {
    entries.push({
      kind: 'work-context',
      subject: 'Azure DevOps 集合',
      value: input.adoBase.trim(),
    });
  }
  const projects = currentProjectSummary(input.workItems, input.prs, input.builds);
  if (projects) {
    entries.push({
      kind: 'work-context',
      subject: '当前工作项目',
      value: projects,
    });
  }
  return entries;
}

function serializeBootstrapDrafts(
  drafts: readonly { kind: ProfileFactKind; subject: string; value: string }[],
): string {
  return drafts
    .map((entry) => `${factKindLabel(entry.kind)} · ${entry.subject}：${entry.value}`)
    .join('\n');
}

export default function ProfileSection() {
  const profileState = useStore(butlerProfile.store);
  const authUser = useAuth((state) => state.user);
  const workbenchConfig = useWorkbench((state) => state.config);
  const workItems = useWorkbench((state) => state.workItems);
  const prs = useWorkbench((state) => state.prs);
  const builds = useWorkbench((state) => state.builds);
  const [kind, setKind] = useState<ProfileFactKind>('preference');
  const [subject, setSubject] = useState('');
  const [value, setValue] = useState('');
  const [adding, setAdding] = useState(false);
  const [editingFile, setEditingFile] = useState(false);
  const [profileDraft, setProfileDraft] = useState('');
  const [bootstrapping, setBootstrapping] = useState(false);
  const [bootstrapNotes, setBootstrapNotes] = useState('');
  const [bootstrapKind, setBootstrapKind] = useState<ProfileFactKind>('work-context');
  const [bootstrapSubject, setBootstrapSubject] = useState('');
  const [bootstrapValue, setBootstrapValue] = useState('');
  const [bootstrapDrafts, setBootstrapDrafts] = useState<Array<{
    kind: ProfileFactKind;
    subject: string;
    value: string;
  }>>([]);

  const confirmed = useMemo(
    () => profileState.facts.filter((fact) => fact.status === 'confirmed'),
    [profileState.facts],
  );
  const candidates = useMemo(
    () => profileState.facts.filter((fact) => fact.status === 'candidate'),
    [profileState.facts],
  );
  const revoked = useMemo(
    () => profileState.facts.filter((fact) => fact.status === 'revoked'),
    [profileState.facts],
  );

  const submitFact = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    try {
      butlerProfile.addExplicit(kind, subject, value);
      setSubject('');
      setValue('');
      setAdding(false);
      toast.success('已更新 Profile，可随时撤销');
    } catch (error) {
      toast.error(error, 'Profile 更新失败');
    }
  };

  const openProfileEditor = (): void => {
    setProfileDraft(butlerProfile.markdown());
    setEditingFile(true);
  };

  const reviewProfileDraft = (): void => {
    const additions = butlerProfile.reviewExternal(profileDraft);
    setEditingFile(false);
    if (additions > 0) {
      toast.success(`识别到 ${additions} 项改动，已放入待确认`);
    } else {
      toast.success('Profile 没有需要确认的新改动');
    }
  };

  const importBootstrapNotes = async (): Promise<void> => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        multiple: false,
        title: '导入 Codex / Claude 资料',
        filters: [
          { name: '文本或 Markdown', extensions: ['md', 'txt'] },
        ],
      });
      if (typeof selected !== 'string' || !selected.trim()) return;
      const { readTextFile } = await import('@tauri-apps/plugin-fs');
      const text = await readTextFile(selected);
      setBootstrapNotes((current) => current.trim() ? `${current}\n\n${text}` : text);
      toast.success('已导入资料，可继续删改后再生成候选');
    } catch (error) {
      toast.error(error, '导入资料失败');
    }
  };

  const bootstrapProfile = (): void => {
    const connectedEntries = buildBootstrapEntries({
      authName: authUser?.name,
      authUsername: authUser?.username,
      adoAccount: workbenchConfig?.account,
      adoBase: workbenchConfig?.adoBase,
      workItems,
      prs,
      builds,
    });
    const importedText = [serializeBootstrapDrafts(bootstrapDrafts), bootstrapNotes.trim()]
      .filter(Boolean)
      .join('\n');
    const additions =
      butlerProfile.addBootstrapCandidates(connectedEntries, 'bootstrap-connected')
      + (importedText ? butlerProfile.reviewBootstrap(importedText, 'bootstrap-imported') : 0);
    setBootstrapping(false);
    if (additions > 0) {
      toast.success(`已整理 ${additions} 项候选资料，等你确认后才会生效`);
    } else {
      toast.success('没有识别到新的初始化资料');
    }
  };

  const addBootstrapDraft = (): void => {
    if (!bootstrapSubject.trim() || !bootstrapValue.trim()) return;
    setBootstrapDrafts((current) => [
      ...current,
      {
        kind: bootstrapKind,
        subject: bootstrapSubject.trim(),
        value: bootstrapValue.trim(),
      },
    ]);
    setBootstrapSubject('');
    setBootstrapValue('');
  };

  return (
    <section aria-label="用户 Profile">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-ink">管家对你的理解</h3>
          <p className="mt-1 text-xs leading-5 text-ink-3">
            明示资料直接生效；观察和 Profile.md 外部改动只进入待确认。
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={openProfileEditor}
            className="inline-flex h-8 items-center gap-1.5 rounded px-2.5 text-xs text-ink-3 hover:bg-fill-hover hover:text-ink"
          >
            <FilePenLine size={13} />
            查看 Profile.md
          </button>
          <button
            type="button"
            onClick={() => setBootstrapping((open) => !open)}
            className="inline-flex h-8 items-center gap-1.5 rounded px-2.5 text-xs text-ink-3 hover:bg-fill-hover hover:text-ink"
          >
            <Sparkles size={13} />
            初始化了解
          </button>
          <button
            type="button"
            onClick={() => setAdding((open) => !open)}
            className="inline-flex h-8 items-center gap-1.5 rounded bg-primary px-2.5 text-xs text-white hover:bg-primary-hover"
          >
            <Sparkles size={13} />
            告诉管家
          </button>
        </div>
      </div>

      {bootstrapping ? (
        <div className="mt-4 rounded-lg border border-line bg-surface-2 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 className="text-sm font-medium text-ink">初始化了解你</h4>
              <p className="mt-1 text-xs leading-5 text-ink-3">
                我会先用当前已授权的 Rocket.Chat / Azure DevOps 资料生成候选；Codex、Claude 等外部资料只会通过你粘贴或导入的文本进入待确认。
              </p>
            </div>
            <button
              type="button"
              onClick={() => void importBootstrapNotes()}
              className="inline-flex h-8 items-center gap-1.5 rounded border border-line px-2.5 text-xs text-ink-3 hover:bg-fill-hover hover:text-ink"
            >
              <FileUp size={13} />
              导入资料
            </button>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border border-line/70 bg-surface-1 px-3 py-2.5 text-xs text-ink-3">
              <p className="font-medium text-ink">当前连接</p>
              <p className="mt-1">Rocket.Chat：{authUser?.name || authUser?.username ? `${authUser?.name || authUser?.username}（@${authUser?.username ?? '未知'}）` : '未登录'}</p>
              <p className="mt-1">Azure DevOps：{workbenchConfig?.account?.trim() || workbenchConfig?.adoBase?.trim() ? `${workbenchConfig?.account?.trim() || '未填写账号'} · ${workbenchConfig?.adoBase?.trim() || '未配置集合'}` : '未配置'}</p>
            </div>
            <div className="rounded-lg border border-line/70 bg-surface-1 px-3 py-2.5 text-xs text-ink-3">
              <p className="font-medium text-ink">外部资料格式</p>
              <p className="mt-1">一行一条，支持「工作方式 · 回复方式：先给结论，再补证据」</p>
              <p className="mt-1">也支持直接粘贴 Profile.md 里的条目行。</p>
            </div>
          </div>
          <label className="mt-3 block text-xs text-ink-3">
            结构化初始化条目（可选）
            <div className="mt-1 grid gap-3 sm:grid-cols-[120px_1fr_1fr_auto]">
              <select
                value={bootstrapKind}
                onChange={(event) => setBootstrapKind(event.target.value as ProfileFactKind)}
                className="h-9 rounded border border-line bg-surface-1 px-2 text-sm text-ink outline-none focus:border-primary"
              >
                {KIND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <input
                value={bootstrapSubject}
                onChange={(event) => setBootstrapSubject(event.target.value)}
                placeholder="资料名称，例如：回复方式"
                className="h-9 rounded border border-line bg-surface-1 px-3 text-sm text-ink outline-none focus:border-primary"
              />
              <input
                value={bootstrapValue}
                onChange={(event) => setBootstrapValue(event.target.value)}
                placeholder="资料内容，例如：先给结论，再补证据"
                className="h-9 rounded border border-line bg-surface-1 px-3 text-sm text-ink outline-none focus:border-primary"
              />
              <button
                type="button"
                onClick={addBootstrapDraft}
                disabled={!bootstrapSubject.trim() || !bootstrapValue.trim()}
                className="h-9 rounded border border-line px-3 text-xs text-ink hover:bg-fill-hover disabled:opacity-40"
              >
                加入条目
              </button>
            </div>
          </label>
          {bootstrapDrafts.length > 0 ? (
            <div className="mt-3 rounded-lg border border-line/70 bg-surface-1 px-3 py-2.5 text-xs text-ink-3">
              <p className="font-medium text-ink">待导入条目</p>
              <div className="mt-2 space-y-1.5">
                {bootstrapDrafts.map((entry, index) => (
                  <div key={`${entry.kind}-${entry.subject}-${index}`} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1">{factKindLabel(entry.kind)} · {entry.subject}：{entry.value}</span>
                    <button
                      type="button"
                      onClick={() => setBootstrapDrafts((current) => current.filter((_, currentIndex) => currentIndex !== index))}
                      className="rounded p-1 text-ink-3 hover:bg-fill-hover hover:text-danger"
                      aria-label={`删除初始化条目${entry.subject}`}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <label className="mt-3 block text-xs text-ink-3">
            粘贴 / 导入条目（可选）
            <textarea
              aria-label="初始化资料"
              value={bootstrapNotes}
              onChange={(event) => setBootstrapNotes(event.target.value)}
              rows={6}
              placeholder="例如：&#10;工作方式 · 回复方式：先给结论，再补证据&#10;边界 · 通知方式：非紧急情况不要频繁打断"
              className="mt-1 w-full resize-y rounded border border-line bg-surface-1 p-3 text-sm leading-6 text-ink outline-none focus:border-primary"
            />
          </label>
          <p className="mt-2 text-[11px] text-ink-3">
            当前连接生成的候选会标注“来自当前连接”；手动填写、粘贴或导入的内容会标注“来自导入/粘贴资料”。
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setBootstrapping(false)}
              className="h-8 rounded px-3 text-xs text-ink-3 hover:bg-fill-hover hover:text-ink"
            >
              取消
            </button>
            <button
              type="button"
              onClick={bootstrapProfile}
              className="h-8 rounded bg-primary px-3 text-xs text-white hover:bg-primary-hover"
            >
              生成候选
            </button>
          </div>
        </div>
      ) : null}

      {adding ? (
        <form onSubmit={submitFact} className="mt-4 rounded-lg border border-line bg-surface-2 p-4">
          <div className="grid gap-3 sm:grid-cols-[120px_1fr]">
            <label className="text-xs text-ink-3">
              类型
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value as ProfileFactKind)}
                className="mt-1 block h-9 w-full rounded border border-line bg-surface-1 px-2 text-sm text-ink outline-none focus:border-primary"
              >
                {KIND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-ink-3">
              资料名称
              <input
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                placeholder="例如：回复方式"
                className="mt-1 block h-9 w-full rounded border border-line bg-surface-1 px-3 text-sm text-ink outline-none focus:border-primary"
              />
            </label>
          </div>
          <label className="mt-3 block text-xs text-ink-3">
            内容
            <input
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="例如：先给结论，再补证据"
              className="mt-1 block h-9 w-full rounded border border-line bg-surface-1 px-3 text-sm text-ink outline-none focus:border-primary"
            />
          </label>
          <p className="mt-2 text-[11px] text-ink-3">
            不保存密码、令牌、密钥、权限指令或可实时查询的动态工作状态。
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="h-8 rounded px-3 text-xs text-ink-3 hover:bg-fill-hover hover:text-ink"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={!subject.trim() || !value.trim()}
              className="h-8 rounded bg-primary px-3 text-xs text-white hover:bg-primary-hover disabled:opacity-40"
            >
              确认写入
            </button>
          </div>
        </form>
      ) : null}

      {editingFile ? (
        <div className="mt-4 rounded-lg border border-line bg-surface-2 p-4">
          <textarea
            aria-label="Profile.md 内容"
            value={profileDraft}
            onChange={(event) => setProfileDraft(event.target.value)}
            rows={12}
            className="w-full resize-y rounded border border-line bg-surface-1 p-3 font-mono text-xs leading-5 text-ink outline-none focus:border-primary"
          />
          <p className="mt-2 text-[11px] text-ink-3">
            这里的改动不会直接覆盖现有理解；保存后会生成待确认项。
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditingFile(false)}
              className="h-8 rounded px-3 text-xs text-ink-3 hover:bg-fill-hover hover:text-ink"
            >
              取消
            </button>
            <button
              type="button"
              onClick={reviewProfileDraft}
              className="h-8 rounded bg-primary px-3 text-xs text-white hover:bg-primary-hover"
            >
              检查改动
            </button>
          </div>
        </div>
      ) : null}

      {candidates.length > 0 ? (
        <div className="mt-5">
          <h4 className="text-xs font-medium text-ink-3">待你确认</h4>
          <div className="mt-2 divide-y divide-line/70 rounded-lg border border-primary/25 bg-primary/5 px-3">
            {candidates.map((fact) => (
              <div key={fact.id} className="flex min-w-0 items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink">
                    <span className="text-ink-3">{factKindLabel(fact.kind)} · </span>
                    {fact.subject}：{fact.value}
                  </p>
                  <p className="mt-0.5 text-[11px] text-ink-3">
                    {fact.origin === 'external-edit'
                      ? '来自 Profile.md 改动'
                      : fact.origin === 'bootstrap-connected'
                        ? '来自当前连接'
                        : fact.origin === 'bootstrap-imported'
                          ? '来自导入/粘贴资料'
                        : '来自行为观察'}，尚未影响管家
                  </p>
                </div>
                <button
                  type="button"
                  aria-label={`确认${fact.subject}`}
                  onClick={() => butlerProfile.confirm(fact.id)}
                  className="rounded p-1.5 text-success hover:bg-success/10"
                >
                  <Check size={14} />
                </button>
                <button
                  type="button"
                  aria-label={`拒绝${fact.subject}`}
                  onClick={() => butlerProfile.revoke(fact.id)}
                  className="rounded p-1.5 text-ink-3 hover:bg-fill-hover hover:text-danger"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-4 divide-y divide-line/70">
        {confirmed.length ? confirmed.map((fact) => (
          <div key={fact.id} className="flex min-w-0 items-center gap-3 py-2.5">
            <span className="shrink-0 text-[11px] text-ink-3">{factKindLabel(fact.kind)}</span>
            <span className="min-w-0 flex-1 text-sm text-ink">
              {fact.subject}<span className="text-ink-3"> = </span>{fact.value}
            </span>
            <button
              type="button"
              aria-label={`撤销${fact.subject}`}
              title="让管家不再使用"
              onClick={() => {
                butlerProfile.revoke(fact.id);
                toast.undo(`已撤销「${fact.subject}」`, () => butlerProfile.restore(fact.id));
              }}
              className="rounded p-1.5 text-ink-3 hover:bg-danger/10 hover:text-danger"
            >
              <Trash2 size={13} />
            </button>
          </div>
        )) : (
          <p className="py-4 text-sm text-ink-3">还没有已确认的资料。你可以先初始化了解，再补一条明确偏好。</p>
        )}
      </div>

      {revoked.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-ink-3">已撤销 {revoked.length} 项</summary>
          <div className="mt-2 space-y-2">
            {revoked.map((fact) => (
              <div key={fact.id} className="flex items-center gap-2 text-xs text-ink-3">
                <span className="flex-1 line-through">{fact.subject}：{fact.value}</span>
                <button
                  type="button"
                  onClick={() => butlerProfile.restore(fact.id)}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-fill-hover hover:text-ink"
                >
                  <RotateCcw size={11} />
                  恢复
                </button>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {profileState.rejectedLines.length > 0 ? (
        <p className="mt-3 text-xs text-danger">
          有 {profileState.rejectedLines.length} 行因格式错误或包含敏感内容而未导入。
        </p>
      ) : null}
    </section>
  );
}
