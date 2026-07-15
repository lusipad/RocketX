import Dialog from './Dialog';

const SHORTCUTS = [
  ['Ctrl + K', '搜索会话、消息和联系人'],
  ['Ctrl + Shift + F', '直接搜索全部消息'],
  ['Ctrl + ↑ / ↓', '按当前可见列表切换会话'],
  ['Ctrl + Shift + ↓', '处理下一条未读会话'],
  ['Alt + ↑ / ↓', '切换左侧模块'],
  ['Alt + 1…6', '按左侧顺序打开模块'],
  ['Ctrl + /', '打开快捷键帮助'],
  ['Esc', '关闭弹窗、右侧面板或退出多选'],
] as const;

export default function ShortcutHelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="快捷键" hint="Windows 使用 Ctrl，macOS 使用 Command" onClose={onClose}>
      <div className="space-y-1 px-5 pt-2 pb-5">
        {SHORTCUTS.map(([keys, description]) => (
          <div key={keys} className="flex items-center justify-between gap-6 rounded-lg px-2 py-2 hover:bg-fill-1">
            <span className="text-sm text-ink-2">{description}</span>
            <kbd className="shrink-0 rounded border border-line bg-fill-1 px-2 py-1 text-xs text-ink">
              {keys}
            </kbd>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
