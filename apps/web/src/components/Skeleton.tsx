/** 骨架屏：加载态占位，避免「空白 → 文字 → 内容」三跳 */

export function SkeletonBar({ w = '100%', h = 12 }: { w?: string | number; h?: number }) {
  return (
    <div
      className="animate-pulse rounded bg-fill-active"
      style={{ width: w, height: h }}
    />
  );
}

/** 列表行骨架（工作台面板、消息列表等） */
export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-4">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-fill-active" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <SkeletonBar w={`${60 + ((i * 13) % 35)}%`} />
            <SkeletonBar w={`${30 + ((i * 17) % 25)}%`} h={9} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** 带头像的列表骨架（会话列表、成员列表） */
export function SkeletonList({ rows = 6, avatar = 36 }: { rows?: number; avatar?: number }) {
  return (
    <div className="space-y-2 p-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-2 py-1.5">
          <div
            className="shrink-0 animate-pulse rounded-lg bg-fill-active"
            style={{ width: avatar, height: avatar }}
          />
          <div className="min-w-0 flex-1 space-y-1.5">
            <SkeletonBar w={`${50 + ((i * 11) % 30)}%`} />
            <SkeletonBar w={`${65 + ((i * 7) % 25)}%`} h={9} />
          </div>
        </div>
      ))}
    </div>
  );
}
