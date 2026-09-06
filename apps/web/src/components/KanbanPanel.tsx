import { useEffect, useMemo, useState, type DragEvent } from 'react';
import type { RcMessage } from '@rcx/rc-client';
import { ArrowLeft, ArrowRight, LayoutGrid, Plus, RotateCcw, X } from 'lucide-react';
import { rest } from '../lib/client';
import { useChat } from '../stores/chat';
import { toast } from '../stores/toast';
import { personName, useAliases } from '../stores/aliases';
import { tsMs, type RoomType } from '@rcx/rc-client';
import {
  aggregateBoard,
  KANBAN_COLUMNS,
  type KanbanCard,
  type KanbanColumn,
} from '../lib/kanban';
import PanelShell from './PanelShell';

/**
 * 频道消息看板面板。
 *
 * 数据 = 看板根消息话题里的事件流（见 lib/kanban.ts）：打开时拉一次话题消息，
 * 之后跟随会话消息缓存（事件消息经房间消息流实时到达），重放聚合出三列卡片。
 * 拖拽或箭头移动卡片 = 追加一条 move 事件，全员实时同步。
 */

function roomTypeOf(rid: string): RoomType {
  const s = useChat.getState();
  return s.subscriptions[rid]?.t ?? s.rooms[rid]?.t ?? 'c';
}

export default function KanbanPanel() {
  const rid = useChat((s) => s.activeRid);
  const roomMessages = useChat((s) => (s.activeRid ? s.messages[s.activeRid] : undefined));
  const aliases = useAliases((s) => s.aliases);
  const nameFormat = useAliases((s) => s.nameFormat);
  const [boardRoot, setBoardRoot] = useState<RcMessage | null>(null);
  const [scanning, setScanning] = useState(true);
  const [threadLoaded, setThreadLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<KanbanColumn | null>(null);
  const [inputFor, setInputFor] = useState<KanbanColumn | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [creating, setCreating] = useState(false);
  const [creatingBoard, setCreatingBoard] = useState(false);

  // 打开（或切频道）时找看板根：本地缓存 → 最近 100 条历史
  useEffect(() => {
    if (!rid) return;
    let current = true;
    setBoardRoot(null);
    setThreadLoaded(false);
    setScanning(true);
    setError(null);
    const cached = (() => {
      const list = useChat.getState().messages[rid];
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].attachments?.some((a) => a.type === 'rcx-kanban-board')) return list[i];
      }
      return null;
    })();
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
        const found = [...history]
          .reverse()
          .find((m) => m.attachments?.some((a) => a.type === 'rcx-kanban-board'));
        if (found) setBoardRoot(found);
      })
      .catch(() => {})
      .finally(() => {
        if (current) setScanning(false);
      });
    return () => {
      current = false;
    };
  }, [rid]);

  // 找到根消息后把话题事件一次性拉进来（之后靠消息流增量更新）
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
        setThreadLoaded(true);
      })
      .catch(() => {
        if (current) {
          // 话题消息拉不到也能用缓存里的增量，只是历史不全
          setThreadLoaded(true);
        }
      });
    return () => {
      current = false;
    };
  }, [rid, boardRoot]);

  const cards = useMemo(() => {
    if (!rid || !boardRoot) return [];
    const cachedThread = (roomMessages ?? []).filter((m) => m.tmid === boardRoot._id);
    return aggregateBoard(cachedThread);
  }, [rid, boardRoot, roomMessages]);

  if (!rid) return null;

  const createBoard = async () => {
    if (creatingBoard) return;
    setCreatingBoard(true);
    setError(null);
    try {
      const root = await useChat.getState().ensureKanbanBoard(rid);
      setBoardRoot(root);
      toast.success('看板已创建');
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建看板失败');
    } finally {
      setCreatingBoard(false);
    }
  };

  const submitCard = async (column: KanbanColumn) => {
    const title = inputValue.trim();
    if (!title || creating) return;
    setCreating(true);
    try {
      await useChat.getState().addKanbanCard(rid, { title, column });
      setInputFor(null);
      setInputValue('');
    } catch {
      /* toast 已由 store 给出 */
    } finally {
      setCreating(false);
    }
  };

  const moveCard = async (card: KanbanCard, to: KanbanColumn) => {
    if (card.column === to) return;
    await useChat.getState().moveKanbanCard(rid, card.id, to, card.title);
  };

  const onDrop = (e: DragEvent, column: KanbanColumn) => {
    e.preventDefault();
    setDragOver(null);
    const cardId = dragId ?? e.dataTransfer.getData('text/card-id');
    setDragId(null);
    const card = cards.find((c) => c.id === cardId);
    if (card) void moveCard(card, column);
  };

  return (
    <PanelShell title={<span className="flex items-center gap-1.5"><LayoutGrid size={14} /> 消息看板</span>}>
      {scanning && <div className="p-4 text-sm text-ink-3">正在查找频道看板…</div>}

      {!scanning && !boardRoot && (
        <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
          <LayoutGrid size={28} className="text-ink-3" />
          <div className="text-sm text-ink-2">这个频道还没有看板</div>
          <div className="max-w-[220px] text-xs leading-relaxed text-ink-3">
            看板归这个频道所有：卡片作为话题消息保存在服务端，成员实时共享，也可以把聊天里的消息一键收进来。
          </div>
          <button
            onClick={() => void createBoard()}
            disabled={creatingBoard}
            className="h-8 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover disabled:opacity-40"
          >
            {creatingBoard ? '创建中…' : '创建看板'}
          </button>
          {error && <div className="text-xs text-danger">{error}</div>}
        </div>
      )}

      {boardRoot && (
        <div className="flex flex-1 flex-col overflow-hidden">
          {!threadLoaded && <div className="px-4 py-2 text-xs text-ink-3">看板事件加载中…</div>}
          <div className="flex flex-1 gap-2 overflow-x-auto px-3 pb-3">
            {KANBAN_COLUMNS.map((column) => {
              const list = cards.filter((c) => c.column === column.key);
              return (
                <section
                  key={column.key}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(column.key);
                  }}
                  onDragLeave={() => setDragOver((v) => (v === column.key ? null : v))}
                  onDrop={(e) => onDrop(e, column.key)}
                  className={`flex min-w-[168px] flex-1 flex-col rounded-lg border bg-surface-2 transition ${
                    dragOver === column.key ? 'border-primary bg-primary-light/40' : 'border-line'
                  }`}
                >
                  <div className="flex items-center justify-between px-2.5 py-2">
                    <span className="text-xs font-medium text-ink-2">{column.name}</span>
                    <span className="text-xs text-ink-3">{list.length}</span>
                  </div>
                  <div className="flex min-h-16 flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-2">
                    {list.map((card) => (
                      <div
                        key={card.id}
                        draggable={!creating}
                        onDragStart={() => setDragId(card.id)}
                        onDragEnd={() => setDragId(null)}
                        data-kanban-card={card.id}
                        className={`group cursor-grab rounded-lg border border-line bg-surface-4 px-2.5 py-2 shadow-[0_1px_3px_rgba(31,35,41,0.06)] transition active:cursor-grabbing ${
                          dragId === card.id ? 'opacity-40' : ''
                        }`}
                      >
                        <div className="flex items-start gap-1">
                          {card.sourceMid ? (
                            <button
                              title="跳到原消息"
                              onClick={() => void useChat.getState().jumpToMessage(card.sourceMid!, rid)}
                              className="min-w-0 flex-1 text-left text-xs leading-relaxed text-ink transition hover:text-primary"
                            >
                              {card.title}
                            </button>
                          ) : (
                            <span className="min-w-0 flex-1 text-xs leading-relaxed text-ink">
                              {card.title}
                            </span>
                          )}
                          <button
                            title="删除卡片"
                            onClick={() => void useChat.getState().removeKanbanCard(rid, card.id, card.title)}
                            className="shrink-0 rounded text-ink-3 opacity-0 transition hover:text-danger group-hover:opacity-100"
                          >
                            <X size={12} />
                          </button>
                        </div>
                        <div className="mt-1 flex items-center justify-between gap-1">
                          <span className="truncate text-xs text-ink-3">
                            {personName(aliases, card.by, card.by, nameFormat)}
                          </span>
                          <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                            {KANBAN_COLUMNS.filter((c) => c.key !== column.key).map((c) => (
                              <button
                                key={c.key}
                                title={`移到 ${c.name}`}
                                onClick={() => void moveCard(card, c.key)}
                                className="rounded p-0.5 text-ink-3 transition hover:bg-fill-hover hover:text-ink"
                              >
                                {KANBAN_COLUMNS.findIndex((x) => x.key === c.key) <
                                KANBAN_COLUMNS.findIndex((x) => x.key === column.key) ? (
                                  <ArrowLeft size={11} />
                                ) : (
                                  <ArrowRight size={11} />
                                )}
                              </button>
                            ))}
                          </span>
                        </div>
                      </div>
                    ))}
                    {inputFor === column.key ? (
                      <div className="rounded-lg border border-primary bg-surface-4 px-2 py-1.5">
                        <input
                          autoFocus
                          value={inputValue}
                          onChange={(e) => setInputValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                              e.preventDefault();
                              void submitCard(column.key);
                            }
                            if (e.key === 'Escape') {
                              setInputFor(null);
                              setInputValue('');
                            }
                          }}
                          placeholder="卡片标题，Enter 确认"
                          className="w-full bg-transparent text-xs outline-none placeholder:text-ink-3"
                        />
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setInputFor(column.key);
                          setInputValue('');
                        }}
                        className="flex items-center gap-1 rounded-lg border border-dashed border-line px-2 py-1.5 text-xs text-ink-3 transition hover:border-primary hover:text-primary"
                      >
                        <Plus size={11} />
                        新建卡片
                      </button>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
          <div className="flex items-center gap-1.5 border-t border-line px-4 py-2 text-xs text-ink-3">
            <RotateCcw size={11} />
            卡片改动会作为话题消息同步给所有成员
          </div>
        </div>
      )}
    </PanelShell>
  );
}
