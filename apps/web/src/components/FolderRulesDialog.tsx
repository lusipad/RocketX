import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { buildConversations, useChat } from '../stores/chat';
import {
  RULE_LABELS,
  ruleMatches,
  useFolders,
  type Folder,
  type FolderRule,
  type RuleMode,
} from '../stores/folders';
import { toast } from '../stores/toast';
import Dialog from './Dialog';

const MODES: RuleMode[] = ['prefix', 'contains', 'regex'];

const PLACEHOLDER: Record<RuleMode, string> = {
  prefix: '如 WI —— 匹配「WI-1234 登录报错」',
  contains: '如 发布 —— 匹配任何名字里带「发布」的会话',
  regex: '如 ^WI-\\d+ —— 正则，忽略大小写',
};

/**
 * 分组规则：命中的会话自动进组，不用一个个拖。
 * 规则实时预览命中了哪些会话——不然写完规则不知道会不会生效。
 */
export default function FolderRulesDialog({
  folder,
  onClose,
}: {
  folder: Folder;
  onClose: () => void;
}) {
  const setRules = useFolders((s) => s.setRules);
  const subscriptions = useChat((s) => s.subscriptions);
  const rooms = useChat((s) => s.rooms);

  const [rules, setLocal] = useState<FolderRule[]>(
    folder.rules?.length ? folder.rules : [{ mode: 'prefix', value: '' }],
  );

  const conversations = useMemo(
    () => buildConversations(subscriptions, rooms),
    [subscriptions, rooms],
  );

  // 实时预览：任一规则命中即算数（与实际归组逻辑一致）
  const matched = useMemo(
    () =>
      conversations.filter((c) =>
        rules.some((r) => r.value.trim() && ruleMatches(r, c.name)),
      ),
    [conversations, rules],
  );

  const update = (i: number, patch: Partial<FolderRule>) =>
    setLocal((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const save = () => {
    const clean = rules.filter((r) => r.value.trim());
    setRules(folder.id, clean);
    toast.success(
      clean.length ? `规则已保存，自动归入 ${matched.length} 个会话` : '规则已清空',
    );
    onClose();
  };

  const badRegex = rules.some((r) => {
    if (r.mode !== 'regex' || !r.value.trim()) return false;
    try {
      new RegExp(r.value);
      return false;
    } catch {
      return true;
    }
  });

  return (
    <Dialog
      title={`「${folder.name}」的分组规则`}
      hint="命中规则的会话会自动进入该分组，不影响你手工拖进来的会话。"
      width={520}
      onClose={onClose}
      footer={
        <>
          <button
            onClick={onClose}
            className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 hover:bg-fill-hover"
          >
            取消
          </button>
          <button
            onClick={save}
            disabled={badRegex}
            className="h-8 rounded-md bg-primary px-4 text-sm text-white hover:bg-primary-hover disabled:opacity-40"
          >
            保存规则
          </button>
        </>
      }
    >
      <div className="space-y-2 px-5 pb-3">
        {rules.map((r, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <select
              value={r.mode}
              onChange={(e) => update(i, { mode: e.target.value as RuleMode })}
              className="h-8 shrink-0 rounded-md border border-line bg-surface-4 px-2 text-xs text-ink outline-none focus:border-primary"
            >
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {RULE_LABELS[m]}
                </option>
              ))}
            </select>
            <input
              autoFocus={i === 0}
              value={r.value}
              onChange={(e) => update(i, { value: e.target.value })}
              placeholder={PLACEHOLDER[r.mode]}
              className="h-8 min-w-0 flex-1 rounded-md border border-line px-2.5 text-sm outline-none focus:border-primary"
            />
            <button
              onClick={() => setLocal((rs) => rs.filter((_, idx) => idx !== i))}
              disabled={rules.length === 1}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-3 transition hover:bg-fill-hover hover:text-danger disabled:opacity-30"
              title="删除这条规则"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}

        <button
          onClick={() => setLocal((rs) => [...rs, { mode: 'prefix', value: '' }])}
          className="flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <Plus size={13} />
          添加规则（多条之间是「或」）
        </button>

        {badRegex && <div className="text-xs text-danger">正则写错了，检查一下语法</div>}
      </div>

      {/* 命中预览 */}
      <div className="mx-5 mb-3 rounded-md border border-line bg-fill-1 p-2.5">
        <div className="mb-1.5 text-xs text-ink-3">
          当前命中 <span className="font-medium text-primary">{matched.length}</span> 个会话
          {matched.length === 0 && rules.some((r) => r.value.trim()) && '（没匹配到，检查一下规则）'}
        </div>
        <div className="max-h-32 space-y-0.5 overflow-y-auto">
          {matched.slice(0, 20).map((c) => (
            <div key={c.rid} className="truncate text-xs text-ink-2">
              {c.name}
            </div>
          ))}
          {matched.length > 20 && (
            <div className="text-xs text-ink-3">…还有 {matched.length - 20} 个</div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
