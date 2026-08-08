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
import { humanError, toast } from '../../../../stores/toast';
import { useAuth } from '../../../../stores/auth';
import { useWorkbench } from '../../../../stores/workbench';
import type { ProfileFactKind } from '../model';
import { butlerProfile } from '../runtime';
import { generateProfileBootstrapCandidates } from '../profileBootstrapAi';
import { collectProfileBootstrapSources } from '../profileBootstrapSources';

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
  const [generatingBootstrap, setGeneratingBootstrap] = useState(false);
  const [bootstrapNotes, setBootstrapNotes] = useState('');
  const [bootstrapSources, setBootstrapSources] = useState({
    currentConnection: true,
    recentCodex: false,
    recentClaude: false,
  });

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
        title: '导入补充摘要',
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

  const bootstrapProfile = async (): Promise<void> => {
    const loadingId = toast.loading('正在整理来源…');
    setGeneratingBootstrap(true);
    try {
      const collected = await collectProfileBootstrapSources({
        selection: bootstrapSources,
        currentConnection: {
          authName: authUser?.name,
          authUsername: authUser?.username,
          adoAccount: workbenchConfig?.account,
          adoBase: workbenchConfig?.adoBase,
          workItems,
          prs,
          builds,
        },
        manualSupplement: bootstrapNotes,
      });
      if (!collected.snapshots.length) {
        throw new Error(
          collected.unavailable.map((item) => item.message).join('；')
          || '至少选择一个可用来源，或导入一段补充摘要。',
        );
      }
      const drafts = await generateProfileBootstrapCandidates({
        sourceSnapshots: collected.snapshots,
        manualSupplement: bootstrapNotes,
        existingFacts: profileState.facts,
      });
      const additions = butlerProfile.addGeneratedCandidates(drafts);
      setBootstrapping(false);
      toast.update(loadingId, {
        kind: 'success',
        message: additions > 0
          ? `已生成 ${additions} 项候选资料，等你确认后才会生效`
          : '没有识别到新的候选资料',
      });
      if (collected.unavailable.length > 0) {
        toast.info(collected.unavailable.map((item) => item.message).join('；'));
      }
    } catch (error) {
      toast.update(loadingId, {
        kind: 'error',
        message: humanError(error, '初始化资料生成失败'),
      });
    } finally {
      setGeneratingBootstrap(false);
    }
  };

  return (
    <section aria-label="用户 Profile">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-ink">关于你的记忆</h3>
          <p className="mt-1 text-xs leading-5 text-ink-3">
            Codex 会在对话空闲后持续维护并按相关性轻量召回；这里的已确认资料优先，且可随时纠正。
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
            从历史补全
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
              <h4 className="text-sm font-medium text-ink">从历史补全画像</h4>
              <p className="mt-1 text-xs leading-5 text-ink-3">
                只有点击“生成候选”才会读取所选来源最近 14 天、最多 20 段只读摘要；生成的可见画像仍由你确认。
              </p>
            </div>
            <button
              type="button"
              onClick={() => void importBootstrapNotes()}
              className="inline-flex h-8 items-center gap-1.5 rounded border border-line px-2.5 text-xs text-ink-3 hover:bg-fill-hover hover:text-ink"
            >
              <FileUp size={13} />
              导入摘要
            </button>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border border-line/70 bg-surface-1 px-3 py-2.5 text-xs text-ink-3">
              <p className="font-medium text-ink">数据来源</p>
              <label className="mt-2 flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={bootstrapSources.currentConnection}
                  onChange={(event) => setBootstrapSources((current) => ({
                    ...current,
                    currentConnection: event.target.checked,
                  }))}
                  aria-label="当前连接"
                  className="mt-0.5 rounded border-line"
                />
                <span>
                  <span className="block text-ink">当前连接</span>
                  <span className="block">默认开启；仅使用当前已授权的 Rocket.Chat / Azure DevOps 摘要。</span>
                </span>
              </label>
              <label className="mt-2 flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={bootstrapSources.recentCodex}
                  onChange={(event) => setBootstrapSources((current) => ({
                    ...current,
                    recentCodex: event.target.checked,
                  }))}
                  aria-label="最近 Codex"
                  className="mt-0.5 rounded border-line"
                />
                <span>
                  <span className="block text-ink">最近 Codex</span>
                  <span className="block">默认关闭；只读最近 14 天、最多 20 段本机 Codex 会话摘要。</span>
                </span>
              </label>
              <label className="mt-2 flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={bootstrapSources.recentClaude}
                  onChange={(event) => setBootstrapSources((current) => ({
                    ...current,
                    recentClaude: event.target.checked,
                  }))}
                  aria-label="最近 Claude"
                  className="mt-0.5 rounded border-line"
                />
                <span>
                  <span className="block text-ink">最近 Claude</span>
                  <span className="block">默认关闭；当前版本若不能安全直读，会提示你改用导入摘要。</span>
                </span>
              </label>
            </div>
            <div className="rounded-lg border border-line/70 bg-surface-1 px-3 py-2.5 text-xs text-ink-3">
              <p className="font-medium text-ink">当前连接概览</p>
              <p className="mt-1">Rocket.Chat：{authUser?.name || authUser?.username ? `${authUser?.name || authUser?.username}（@${authUser?.username ?? '未知'}）` : '未登录'}</p>
              <p className="mt-1">Azure DevOps：{workbenchConfig?.account?.trim() || workbenchConfig?.adoBase?.trim() ? `${workbenchConfig?.account?.trim() || '未填写账号'} · ${workbenchConfig?.adoBase?.trim() || '未配置集合'}` : '未配置'}</p>
              <p className="mt-2 text-[11px]">
                不会后台扫描，不会调用 remember，也不会读取秘密或私有文件。
              </p>
            </div>
          </div>
          <label className="mt-3 block text-xs text-ink-3">
            补充摘要（可选）
            <textarea
              aria-label="补充摘要"
              value={bootstrapNotes}
              onChange={(event) => setBootstrapNotes(event.target.value)}
              rows={6}
              placeholder="例如：&#10;Claude 最近总结：非紧急情况先异步整理，再统一回复。&#10;或者粘贴你手动整理的一段稳定工作偏好摘要。"
              className="mt-1 w-full resize-y rounded border border-line bg-surface-1 p-3 text-sm leading-6 text-ink outline-none focus:border-primary"
            />
          </label>
          <p className="mt-2 text-[11px] text-ink-3">
            每条候选都会附带来源和证据摘要；默认只是 candidate，仍然需要你确认。
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
              onClick={() => void bootstrapProfile()}
              disabled={generatingBootstrap}
              className="h-8 rounded bg-primary px-3 text-xs text-white hover:bg-primary-hover disabled:opacity-40"
            >
              {generatingBootstrap ? '生成中…' : '生成候选'}
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
                    {(fact.provenance?.source.label)
                      || (fact.origin === 'external-edit'
                        ? '来自 Profile.md 改动'
                        : fact.origin === 'bootstrap-connected'
                          ? '来自当前连接'
                          : fact.origin === 'bootstrap-imported'
                            ? '来自导入/粘贴资料'
                            : '来自行为观察')}，尚未影响管家
                  </p>
                  {fact.provenance?.evidenceSummary ? (
                    <p className="mt-0.5 text-[11px] text-ink-3">
                      证据：{fact.provenance.evidenceSummary}
                    </p>
                  ) : null}
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
          <p className="py-4 text-sm text-ink-3">还没有已确认的资料。自动记忆会在后台维护；你也可以从历史补全，或直接告诉管家。</p>
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
