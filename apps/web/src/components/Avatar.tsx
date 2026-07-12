import { useState } from 'react';

const PALETTE = ['#3370ff', '#7f3bf5', '#00b96b', '#ff8800', '#f54a45', '#04a5a5', '#c71fbf'];

function colorFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/**
 * 头像：优先加载 Rocket.Chat 头像（用户 /avatar/:username，房间 /avatar/room/:rid），
 * 失败时回退为飞书风格的彩色首字圆角块。
 */
export default function Avatar({
  name,
  username,
  roomId,
  size = 40,
}: {
  name: string;
  username?: string;
  roomId?: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const src = username
    ? `/avatar/${encodeURIComponent(username)}?size=${size * 2}`
    : roomId
      ? `/avatar/room/${encodeURIComponent(roomId)}?size=${size * 2}`
      : null;

  const style = {
    width: size,
    height: size,
    borderRadius: Math.max(6, size * 0.22),
  };

  if (!src || failed) {
    return (
      <div
        className="flex shrink-0 select-none items-center justify-center font-medium text-white"
        style={{ ...style, background: colorFor(name), fontSize: size * 0.42 }}
      >
        {[...name][0]?.toUpperCase() ?? '?'}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={name}
      className="shrink-0 object-cover"
      style={style}
      onError={() => setFailed(true)}
    />
  );
}
