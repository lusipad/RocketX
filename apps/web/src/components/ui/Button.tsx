import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Loader2 } from 'lucide-react';
import { ICON } from '../../lib/iconSize';

/**
 * 按钮。
 *
 * 建这个组件之前，全仓库有 329 种不同的按钮类名组合（数字归一化后）——
 * 意味着并排的两个按钮很可能高度不同、圆角不同，hover 反馈还不一样
 * （189 处 `hover:bg-fill-hover`、56 处 `hover:bg-primary-hover`、
 * 还有写 `hover:opacity-90` 的）。而且**全仓库没有一处 focus-visible**：
 * 用键盘操作时根本看不到焦点在哪。
 *
 * 这些都不是靠「再仔细一点」能解决的，得靠只有一个地方能改。
 */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-primary text-white hover:bg-primary-hover active:bg-primary-active disabled:hover:bg-primary',
  secondary: 'border border-line bg-surface text-ink hover:bg-fill-hover active:bg-fill-active disabled:hover:bg-surface',
  ghost: 'text-ink-2 hover:bg-fill-hover hover:text-ink active:bg-fill-active disabled:hover:bg-transparent',
  danger: 'border border-danger/40 bg-surface text-danger hover:bg-danger/10 active:bg-danger/15 disabled:hover:bg-surface',
};

/** 高度与内边距成对出现——分开写就是 h-7/8/9/10 与 px-1..6 各自漂移的由来 */
const SIZE: Record<Size, string> = {
  sm: 'h-7 gap-1 rounded-md px-2.5 text-xs',
  md: 'h-8 gap-1.5 rounded-md px-3 text-sm',
};

const ICON_SIZE: Record<Size, number> = {
  sm: ICON.XS,
  md: ICON.SM,
};

/** 图标按钮里图标是主体不是配角，跟文字并列时的尺寸会显小一档 */
const ICON_ONLY_SIZE: Record<Size, number> = {
  sm: ICON.SM,
  md: ICON.MD,
};

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: Variant;
  size?: Size;
  /** 前置图标，尺寸跟着 size 走，不用各处自己挑 */
  icon?: LucideIcon;
  /** 转圈并禁用；文字保持原样，避免按钮宽度跳动 */
  loading?: boolean;
  /** 仅图标按钮：正方形并要求 aria-label */
  iconOnly?: boolean;
  children?: ReactNode;
  /** 布局用（宽度、外边距、对齐）。视觉样式一律走 variant/size，不从外面覆盖 */
  layout?: string;
}

export default function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  loading = false,
  iconOnly = false,
  disabled,
  children,
  layout = '',
  type = 'button',
  ...rest
}: ButtonProps) {
  const iconSize = iconOnly ? ICON_ONLY_SIZE[size] : ICON_SIZE[size];
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={[
        'inline-flex shrink-0 items-center justify-center font-medium transition-colors',
        // 焦点必须看得见，而且只在键盘操作时出现——鼠标点击后留一圈环是噪音
        'outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-1 focus-visible:ring-offset-surface',
        'disabled:cursor-not-allowed disabled:opacity-50',
        SIZE[size],
        iconOnly ? (size === 'sm' ? 'w-7 px-0' : 'w-8 px-0') : '',
        VARIANT[variant],
        layout,
      ].filter(Boolean).join(' ')}
      {...rest}
    >
      {loading ? <Loader2 size={iconSize} className="animate-spin" /> : Icon ? <Icon size={iconSize} /> : null}
      {iconOnly ? null : children}
    </button>
  );
}
