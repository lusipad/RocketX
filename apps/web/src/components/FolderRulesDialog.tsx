import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { buildConversations, useChat } from '../stores/chat';
import { useI18n, type MessageKey } from '../i18n';
import {
  ruleMatches,
  useFolders,
  type Folder,
  type FolderRule,
  type RuleMode,
} from '../stores/folders';
import { toast } from '../stores/toast';
import Dialog from './Dialog';

const MODES: RuleMode[] = ['prefix', 'contains', 'regex'];

const MODE_LABEL_KEYS: Record<RuleMode, MessageKey> = {
  prefix: 'chat.folderRules.mode.prefix',
  contains: 'chat.folderRules.mode.contains',
  regex: 'chat.folderRules.mode.regex',
};

const PLACEHOLDER_KEYS: Record<RuleMode, MessageKey> = {
  prefix: 'chat.folderRules.placeholder.prefix',
  contains: 'chat.folderRules.placeholder.contains',
  regex: 'chat.folderRules.placeholder.regex',
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
  const { t, tp } = useI18n();
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
      clean.length
        ? tp(matched.length, 'chat.folderRules.savedOne', 'chat.folderRules.savedOther')
        : t('chat.folderRules.cleared'),
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
      title={t('chat.folderRules.title', { name: folder.name })}
      hint={t('chat.folderRules.hint')}
      width={520}
      onClose={onClose}
      footer={
        <>
          <button
            onClick={onClose}
            className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 hover:bg-fill-hover"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={save}
            disabled={badRegex}
            className="h-8 rounded-md bg-primary px-4 text-sm text-white hover:bg-primary-hover disabled:opacity-40"
          >
            {t('chat.folderRules.save')}
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
                  {t(MODE_LABEL_KEYS[m])}
                </option>
              ))}
            </select>
            <input
              autoFocus={i === 0}
              value={r.value}
              onChange={(e) => update(i, { value: e.target.value })}
              placeholder={t(PLACEHOLDER_KEYS[r.mode])}
              className="h-8 min-w-0 flex-1 rounded-md border border-line px-2.5 text-sm outline-none focus:border-primary"
            />
            <button
              onClick={() => setLocal((rs) => rs.filter((_, idx) => idx !== i))}
              disabled={rules.length === 1}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-3 transition hover:bg-fill-hover hover:text-danger disabled:opacity-30"
              title={t('chat.folderRules.deleteRule')}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}

        <button
          onClick={() => setLocal((rs) => [...rs, { mode: 'prefix', value: '' }])}
          className="flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <Plus size={14} />
          {t('chat.folderRules.addRule')}
        </button>

        {badRegex && <div className="text-xs text-danger">{t('chat.folderRules.invalidRegex')}</div>}
      </div>

      {/* 命中预览 */}
      <div className="mx-5 mb-3 rounded-md border border-line bg-fill-1 p-2.5">
        <div className="mb-1.5 text-xs text-ink-3">
          {tp(matched.length, 'chat.folderRules.matchedOne', 'chat.folderRules.matchedOther')}
          {matched.length === 0 && rules.some((r) => r.value.trim()) && t('chat.folderRules.noMatchHint')}
        </div>
        <div className="max-h-32 space-y-0.5 overflow-y-auto">
          {matched.slice(0, 20).map((c) => (
            <div key={c.rid} className="truncate text-xs text-ink-2">
              {c.name}
            </div>
          ))}
          {matched.length > 20 && (
            <div className="text-xs text-ink-3">{t('chat.folderRules.moreCount', { count: matched.length - 20 })}</div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
