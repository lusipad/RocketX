import type { HTMLAttributes, ReactNode } from 'react';

/**
 * 卡片。
 *
 * 视觉基调参考 Claude Code：**靠背景色差浮起，不靠边框**。
 * 一屏十几张卡各画一圈线，界面会被切得很碎；去掉线之后同样的信息
 * 读起来是连续的。
 *
 * 深色下 surface-3(页面) 与 surface-4(卡片) 差一档，足够看出层次；
 * 浅色下两者目前都是 #ffffff，所以浅色主题保留一条极淡的线兜底
 * ——这是 `bordered` 的用途，不是给人随手加边框用的。
 */

type Tone = 'raised' | 'inset' | 'plain';

const TONE: Record<Tone, string> = {
  /** 页面背景上的卡片 */
  raised: 'bg-surface',
  /** 卡片内部再凹一层：引用块、代码块、列表项 */
  inset: 'bg-surface-2',
  /** 只要间距和圆角，不要背景 */
  plain: '',
};

const PAD = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-5',
} as const;

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'className'> {
  tone?: Tone;
  pad?: keyof typeof PAD;
  /** 浅色主题下卡片与页面同为白色时的兜底细线；深色下不需要 */
  bordered?: boolean;
  as?: 'div' | 'section' | 'article';
  children?: ReactNode;
  /** 布局用（宽度、外边距、flex）。视觉一律走 tone/pad */
  layout?: string;
}

export default function Card({
  tone = 'raised',
  pad = 'md',
  bordered = false,
  as: Tag = 'div',
  children,
  layout = '',
  ...rest
}: CardProps) {
  return (
    <Tag
      className={[
        'rounded-xl',
        TONE[tone],
        PAD[pad],
        bordered ? 'border border-line' : '',
        layout,
      ].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </Tag>
  );
}
