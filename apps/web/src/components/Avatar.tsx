import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { useAuth } from '../stores/auth';
import { observeNearViewport } from '../lib/nearViewport';
import AuthImage from './AuthImage';

const PALETTE = ['#3b6cf0', '#6e56cf', '#12a594', '#d97706', '#e5484d', '#0891b2', '#db2777'];

function colorFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/**
 * 头像：优先加载 Rocket.Chat 头像（用户 /avatar/:username，房间 /avatar/room/:rid），
 * 失败时回退为飞书风格的彩色首字圆角块。
 */
/** 在线状态点的颜色（online 绿 / away 黄 / busy 红 / offline 灰） */
const STATUS_COLOR: Record<string, string> = {
  online: '#00b96b',
  away: '#ff8800',
  busy: '#f54a45',
  offline: '#8a9099',
};

export default function Avatar({
  name,
  username,
  roomId,
  size = 40,
  status,
}: {
  name: string;
  username?: string;
  roomId?: string;
  size?: number;
  /** 在线状态：传入时在右下角显示对应颜色的状态点 */
  status?: string;
}) {
  /**
   * 换过头像就带上版本号，否则 URL 没变、浏览器直接给缓存，新头像永远不显示。
   *
   * **只作用于自己的头像**：以前是无差别挂到每一个 Avatar 上，换一次头像，会话列表和
   * 消息列表里所有人的头像 URL 全变 —— 桌面端的 blobCache 以 path 为 key，于是整屏头像
   * 重新 fetch 一遍，旧的 objectURL 还从不 revoke，每换一次泄漏一批。
   */
  const t = useT();
  const version = useAuth((s) => s.avatarVersion);
  const myUsername = useAuth((s) => s.user?.username);
  const localMode = useAuth((s) => s.localMode);
  const bust = version > 0 && username && username === myUsername ? `&v=${version}` : '';

  const path = localMode
    ? null
    : username
    ? `/avatar/${encodeURIComponent(username)}?size=${size * 2}${bust}`
    : roomId
      ? `/avatar/room/${encodeURIComponent(roomId)}?size=${size * 2}`
      : null;
  const rootRef = useRef<HTMLSpanElement>(null);
  const [readyPath, setReadyPath] = useState<string | null>(() =>
    typeof IntersectionObserver === 'undefined' ? path : null,
  );

  useEffect(() => {
    if (!path) {
      setReadyPath(null);
      return;
    }
    const node = rootRef.current;
    if (!node) {
      setReadyPath(path);
      return;
    }
    return observeNearViewport(node, () => setReadyPath(path));
  }, [path]);

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

  const dotColor = status ? STATUS_COLOR[status] : undefined;
  const dotSize = Math.max(8, Math.round(size * 0.28));
  const dot = dotColor ? (
    <span
      className="absolute right-0 bottom-0 rounded-full border-2 border-surface-4"
      style={{ width: dotSize, height: dotSize, background: dotColor }}
      title={status === 'away' ? t('nav.presence.away') : status === 'busy' ? t('nav.presence.busy') : status === 'offline' ? t('nav.presence.offline') : t('nav.presence.online')}
    />
  ) : null;

  const inner = !path || readyPath !== path ? (
    letterTile
  ) : (
    <AuthImage
      path={path}
      alt={name}
      className="shrink-0 object-cover"
      style={style}
      fallback={letterTile}
    />
  );

  return (
    <span
      ref={rootRef}
      className="relative inline-flex shrink-0"
      style={{ width: size, height: size }}
    >
      {inner}
      {dot}
    </span>
  );
}
