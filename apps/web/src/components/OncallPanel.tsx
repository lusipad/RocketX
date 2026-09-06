import { useEffect, useMemo, useState } from 'react';
import type { RcMessage, RcUser, RoomType } from '@rcx/rc-client';
import { CalendarClock, Send, Trash2, UserPlus } from 'lucide-react';
import { rest } from '../lib/client';
import { useChat } from '../stores/chat';
import { useAuth } from '../stores/auth';
import { toast } from '../stores/toast';
import { personName, useAliases } from '../stores/aliases';
import { tsMs } from '@rcx/rc-client';
import { aggregateOncall, type OncallShift } from '../lib/oncall';
import { useUserSearch } from './NewChatDialogs';
import PanelShell from './PanelShell';

/**
 * 频道值班表面板。
 *
 * 数据与看板同款线程事件流：根消息 + 排班事件回复，打开时拉一次话题，
 * 之后跟随会话消息缓存实时更新。「发布」往主频道发一份文本快照，方便没开面板的人看。
 */

const SHIFT_PRESETS = ['全天', '早班', '晚班', '夜班'];

function roomTypeOf(rid: string): RoomType {
  const s = useChat.getState();
  return s.subscriptions[rid]?.t ?? s.rooms[rid]?.t ?? 'c';
}

export default function OncallPanel() {
  const rid = useChat((s) => s.activeRid);
  const myUsername = useAuth((s) => s.user?.username);
  const roomMessages = useChat((s) => (s.activeRid ? s.messages[s.activeRid] : undefined));
  const aliases = useAliases((s) => s.aliases);
  const nameFormat = useAliases((s) => s.nameFormat);
  const [boardRoot, setBoardRoot] = useState<RcMessage | null>(null);
  const [scanning, setScanning] = useState(true);
  const [loaded, setLoaded] = useState(false);

  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [shift, setShift] = useState('全天');
  const [member, setMember] = useState<RcUser | null>(null);
  const [keyword, setKeyword] = useState('');
  const [adding, setAdding] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const { users } = useUserSearch(keyword);

  useEffect(() => {
    if (!rid) return;
    let current = true;
    setBoardRoot(null);
    setLoaded(false);
    setScanning(true);
    const scan = (list: RcMessage[]) => {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].attachments?.some((a) => a.type === 'rcx-oncall-board')) return list[i];
      }
      return null;
    };
    const cached = scan(useChat.getState().messages[rid] ?? []);
    if (cached) {
      setBoardRoot(cached);
      setScanning(false);
      return () => {
        current = false;
      };
    }
    void rest
      .getHistory(rid, roomTypeOf(rid), 100)
      .then((history) => {
        if (!current) return;
        setBoardRoot(scan(history));
      })
      .catch(() => {})
      .finally(() => {
        if (current) setScanning(false);
      });
    return () => {
      current = false;
    };
  }, [rid]);

  useEffect(() => {
    if (!rid || !boardRoot) return;
    let current = true;
    void rest
      .getThreadMessages(boardRoot._id)
      .then((thread) => {
        if (!current) return;
        const snapshot = useChat.getState();
        let list = snapshot.messages[rid] ?? [];
        for (const m of thread) if (!list.some((x) => x._id === m._id)) list = [...list, m];
        list.sort((a, b) => tsMs(a.ts) - tsMs(b.ts));
        useChat.setState({ messages: { ...snapshot.messages, [rid]: list } });
        setLoaded(true);
      })
      .catch(() => {
        if (current) setLoaded(true);
      });
    return () => {
      current = false;
    };
  }, [rid, boardRoot]);

  const shifts = useMemo(() => {
    if (!rid || !boardRoot) return [] as OncallShift[];
    const cachedThread = (roomMessages ?? []).filter((m) => m.tmid === boardRoot._id);
    return aggregateOncall(cachedThread);
  }, [rid, boardRoot, roomMessages]);

  if (!rid) return null;

  const createBoard = async () => {
    try {
      const root = await useChat.getState().ensureOncallBoard(rid);
      setBoardRoot(root);
    } catch (err) {
      toast.error(err, '创建值班表失败');
    }
  };

  const doAdd = async () => {
    if (!member || !date || !shift.trim() || adding) return;
    setAdding(true);
    try {
      await useChat.getState().addOncallShift(rid, { date, shift: shift.trim(), username: member.username });
      setMember(null);
      setKeyword('');
    } catch {
      /* store 已提示 */
    } finally {
      setAdding(false);
    }
  };

  const doPublish = async () => {
    if (publishing) return;
    setPublishing(true);
    try {
      await useChat.getState().publishOncall(rid, shifts);
    } catch {
      /* store 已提示 */
    } finally {
      setPublishing(false);
    }
  };

  // 按日期分组展示（日期升序）
  const grouped = useMemo(() => {
    const map = new Map<string, OncallShift[]>();
    for (const s of shifts) {
      const list = map.get(s.date) ?? [];
      list.push(s);
      map.set(s.date, list);
    }
    return [...map.entries()];
  }, [shifts]);

  return (
    <PanelShell title={<span className="flex items-center gap-1.5"><CalendarClock size={14} /> 团队值班表</span>}>
      {scanning && <div className="p-4 text-sm text-ink-3">正在查找频道值班表…</div>}

      {!scanning && !boardRoot && (
        <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
          <CalendarClock size={28} className="text-ink-3" />
          <div className="text-sm text-ink-2">这个频道还没有值班表</div>
          <div className="max-w-[220px] text-xs leading-relaxed text-ink-3">
            值班表归这个频道所有：排班记录保存在服务端，成员实时共享，还可以把当前排班发布成消息。
          </div>
          <button
            onClick={() => void createBoard()}
            className="h-8 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover"
          >
            创建值班表
          </button>
        </div>
      )}

      {boardRoot && (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* 新增排班 */}
          <div className="space-y-2 border-b border-line px-4 py-3">
            <div className="flex gap-2">
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="h-8 min-w-0 flex-1 rounded-md border border-line px-2 text-sm outline-none transition focus:border-primary"
              />
              <input
                list="oncall-shift-presets"
                value={shift}
                onChange={(e) => setShift(e.target.value)}
                placeholder="班次"
                className="h-8 w-24 shrink-0 rounded-md border border-line px-2 text-sm outline-none transition focus:border-primary"
              />
              <datalist id="oncall-shift-presets">
                {SHIFT_PRESETS.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </div>
            {member ? (
              <div className="flex items-center gap-2">
                <span className="flex min-w-0 flex-1 items-center gap-2 rounded-md bg-primary-light px-2 py-1 text-xs text-primary">
                  <span className="truncate">
                    {personName(aliases, member.username, member.name || member.username, nameFormat)}
                  </span>
                  <span className="text-primary/70">@{member.username}</span>
                </span>
                <button
                  onClick={() => setMember(null)}
                  className="h-7 shrink-0 rounded-md border border-line px-2.5 text-xs text-ink-2 transition hover:bg-fill-hover"
                >
                  换人
                </button>
              </div>
            ) : (
              <div>
                <div className="flex h-8 items-center gap-2 rounded-md bg-fill-1 px-2.5">
                  <UserPlus size={13} className="text-ink-3" />
                  <input
                    value={keyword}
                    onChange={(e) => setKeyword(e.target.value)}
                    placeholder="选择值班人（搜索用户名）"
                    className="w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
                  />
                </div>
                {keyword.trim() && users.length > 0 && (
                  <div className="mt-1 max-h-36 overflow-y-auto rounded-md border border-line bg-surface-4 py-1">
                    {users.slice(0, 8).map((u) => (
                      <button
                        key={u._id}
                        onClick={() => {
                          setMember(u);
                          setKeyword('');
                        }}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition hover:bg-fill-hover"
                      >
                        <span className="truncate text-ink">
                          {personName(aliases, u.username, u.name || u.username, nameFormat)}
                        </span>
                        <span className="truncate text-xs text-ink-3">@{u.username}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <button
              onClick={() => void doAdd()}
              disabled={!member || !date || !shift.trim() || adding}
              className="h-8 w-full rounded-md bg-primary text-sm text-white transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              {adding ? '排班中…' : '加一条排班'}
            </button>
          </div>

          {/* 排班列表 */}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {grouped.length === 0 && (
              <div className="py-8 text-center text-sm text-ink-3">
                {loaded ? '还没有排班，从上面加一条' : '排班记录加载中…'}
              </div>
            )}
            {grouped.map(([day, list]) => (
              <div key={day} className="mb-3">
                <div className="mb-1 text-xs font-medium text-ink-2">{day}</div>
                <div className="space-y-1">
                  {list.map((s) => (
                    <div
                      key={s.id}
                      data-oncall-shift={s.id}
                      className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5"
                    >
                      <span className="shrink-0 rounded bg-fill-1 px-1.5 py-0.5 text-xs text-ink-2">
                        {s.shift}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-ink">
                        {personName(aliases, s.username, s.username, nameFormat)}
                      </span>
                      {s.username === myUsername && (
                        <span className="shrink-0 rounded bg-primary-light px-1 py-0.5 text-xs text-primary">
                          我
                        </span>
                      )}
                      <button
                        title="取消这条排班"
                        onClick={() => void useChat.getState().removeOncallShift(rid, s.id)}
                        className="shrink-0 rounded p-1 text-ink-3 transition hover:bg-fill-hover hover:text-danger"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="border-t border-line px-4 py-3">
            <button
              onClick={() => void doPublish()}
              disabled={shifts.length === 0 || publishing}
              className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-primary text-sm text-white transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Send size={13} />
              {publishing ? '发布中…' : `发布到频道（${shifts.length} 条排班）`}
            </button>
            <div className="mt-1.5 text-center text-xs text-ink-3">
              排班改动实时同步给所有成员，发布只是发一份文本快照
            </div>
          </div>
        </div>
      )}
    </PanelShell>
  );
}
