import { useState } from 'react';
import { EMOJI_MAP } from '../lib/emoji';
import { assetUrl } from '../lib/client';
import { usePrefs } from '../stores/prefs';

/**
 * 渲染一个表情：标准 shortcode → Unicode；
 * 不认识的名字尝试按 RC 自定义表情（/emoji-custom/{name}.png）渲染，
 * 失败回退为 :name: 文本。关闭「显示表情」偏好时一律显示 :name: 文本。
 */
export default function Emoji({ code, size = 18 }: { code: string; size?: number }) {
  const useEmojis = usePrefs((s) => s.prefs.useEmojis ?? true);
  const name = code.replace(/:/g, '');
  const [imgFailed, setImgFailed] = useState(false);
  const unicode = EMOJI_MAP[name];

  if (!useEmojis) return <span>:{name}:</span>;
  if (unicode) return <span style={{ fontSize: size * 0.9 }}>{unicode}</span>;
  if (imgFailed) return <span>:{name}:</span>;
  return (
    <img
      src={assetUrl(`/emoji-custom/${encodeURIComponent(name)}.png`)}
      alt={`:${name}:`}
      title={`:${name}:`}
      style={{ width: size, height: size }}
      className="inline-block align-text-bottom"
      onError={() => setImgFailed(true)}
    />
  );
}
