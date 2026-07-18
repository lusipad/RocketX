import {
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { X } from 'lucide-react';
import { useChat } from '../stores/chat';
import { useImLayout } from '../stores/imLayout';
import {
  MAX_BUTLER_PANEL_WIDTH,
  MIN_BUTLER_PANEL_WIDTH,
  clampButlerPanelWidth,
} from '../lib/imLayout';

/** 右侧面板统一外壳：标题 + 关闭按钮 */
export default function PanelShell({
  title,
  children,
  resizable = false,
}: {
  title: ReactNode;
  children: ReactNode;
  resizable?: boolean;
}) {
  const setPanel = useChat((s) => s.setPanel);
  const savedWidth = useImLayout((s) => s.layout.butlerPanelWidth);
  const setButlerPanelWidth = useImLayout((s) => s.setButlerPanelWidth);
  const resetButlerPanelWidth = useImLayout((s) => s.resetButlerPanelWidth);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const resizeStart = useRef<{
    x: number;
    width: number;
    currentWidth: number;
    moved: boolean;
  } | null>(null);
  const width = dragWidth ?? savedWidth;

  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStart.current = { x: event.clientX, width, currentWidth: width, moved: false };
    setDragWidth(width);
  };

  const onResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeStart.current;
    if (!start) return;
    const next = clampButlerPanelWidth(start.width + start.x - event.clientX);
    if (next !== start.width) start.moved = true;
    start.currentWidth = next;
    setDragWidth(next);
  };

  const finishResize = () => {
    const start = resizeStart.current;
    if (start?.moved) setButlerPanelWidth(start.currentWidth);
    resizeStart.current = null;
    setDragWidth(null);
  };

  return (
    <>
      {resizable && (
        <div
          role="separator"
          aria-label="调整 AI 面板宽度"
          aria-orientation="vertical"
          aria-valuemin={MIN_BUTLER_PANEL_WIDTH}
          aria-valuemax={MAX_BUTLER_PANEL_WIDTH}
          aria-valuenow={width}
          tabIndex={0}
          title="拖动调整 AI 面板宽度，双击恢复默认"
          onDoubleClick={resetButlerPanelWidth}
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              const delta = event.key === 'ArrowLeft' ? 10 : -10;
              setButlerPanelWidth(width + delta);
            } else if (event.key === 'Home') {
              event.preventDefault();
              resetButlerPanelWidth();
            }
          }}
          style={{ touchAction: 'none' }}
          className="group flex w-1.5 shrink-0 cursor-col-resize items-stretch justify-center bg-surface-3 outline-none focus:bg-primary-light"
        >
          <span className="w-px bg-line transition group-hover:bg-primary group-focus:bg-primary" />
        </div>
      )}
      <aside
        style={resizable ? { width } : undefined}
        className="flex w-[380px] shrink-0 flex-col border-l border-line bg-surface-3"
      >
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
          <span className="text-[15px] font-semibold text-ink">{title}</span>
          <button
            onClick={() => setPanel(null)}
            className="flex h-8 w-8 items-center justify-center rounded-md text-ink-2 transition hover:bg-fill-hover"
          >
            <X size={17} />
          </button>
        </header>
        {children}
      </aside>
    </>
  );
}
