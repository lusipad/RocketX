import { useState } from 'react';
import Dialog from './Dialog';
import { toast } from '../stores/toast';

/**
 * 设置备注名。
 * 备注只存在本机——Rocket.Chat 没有这个字段，说清楚免得用户以为换台电脑还在。
 */
export default function AliasDialog({
  title,
  originalName,
  current,
  onSubmit,
  onClose,
}: {
  title: string;
  /** 原名，清空备注后会回到它 */
  originalName: string;
  current?: string;
  onSubmit: (alias: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(current ?? '');

  const submit = () => {
    onSubmit(value);
    toast.success(value.trim() ? `备注已设为「${value.trim()}」` : '备注已清除');
    onClose();
  };

  return (
    <Dialog
      title={title}
      hint={`原名：${originalName}。备注只保存在本机，换设备需要重新设置。`}
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
            onClick={submit}
            className="h-8 rounded-md bg-primary px-4 text-sm text-white hover:bg-primary-hover"
          >
            {value.trim() ? '保存' : '清除备注'}
          </button>
        </>
      }
    >
      <div className="px-5 pb-2">
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder="留空则清除备注"
          maxLength={30}
          className="h-9 w-full rounded-md border border-line px-3 text-sm outline-none transition focus:border-primary"
        />
        <div className="mt-2 text-xs text-ink-3">备注名同样支持拼音搜索。</div>
      </div>
    </Dialog>
  );
}
