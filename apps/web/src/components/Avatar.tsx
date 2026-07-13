import { useAuth } from '../stores/auth';
import AuthImage from './AuthImage';

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
  // 换过头像就带上版本号，否则 URL 没变、浏览器直接给缓存，新头像永远不显示
  const version = useAuth((s) => s.avatarVersion);
  const bust = version > 0 ? `&v=${version}` : '';

  const path = username
    ? `/avatar/${encodeURIComponent(username)}?size=${size * 2}${bust}`
    : roomId
      ? `/avatar/room/${encodeURIComponent(roomId)}?size=${size * 2}${bust}`
      : null;

  const style = {
    width: size,
    height: size,
    borderRadius: Math.max(6, size * 0.22),
  };

  const letterTile = (
    <div
      className="flex shrink-0 items-center justify-center font-medium text-white select-none"
      style={{ ...style, background: colorFor(name), fontSize: size * 0.42 }}
    >
      {[...name][0]?.toUpperCase() ?? '?'}
    </div>
  );

  if (!path) return letterTile;
  return (
    <AuthImage
      path={path}
      alt={name}
      className="shrink-0 object-cover"
      style={style}
      fallback={letterTile}
    />
  );
}
