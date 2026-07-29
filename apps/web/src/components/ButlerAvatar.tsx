import { Flame, Leaf, Orbit, Sparkles, SunMedium, type LucideIcon } from 'lucide-react';
import type { ButlerAvatar as ButlerAvatarId } from '../lib/butlerIdentity';

export const BUTLER_AVATAR_OPTIONS: Array<{
  id: ButlerAvatarId;
  label: string;
  Icon: LucideIcon;
}> = [
  { id: 'spark', label: '灵光', Icon: Sparkles },
  { id: 'orbit', label: '轨道', Icon: Orbit },
  { id: 'dawn', label: '晨光', Icon: SunMedium },
  { id: 'moss', label: '青苔', Icon: Leaf },
  { id: 'ember', label: '余火', Icon: Flame },
];

export default function ButlerAvatar({
  avatar,
  name,
  size = 'medium',
}: {
  avatar: ButlerAvatarId;
  name: string;
  size?: 'small' | 'medium' | 'large';
}) {
  const option = BUTLER_AVATAR_OPTIONS.find((candidate) => candidate.id === avatar)
    ?? BUTLER_AVATAR_OPTIONS[0];
  const Icon = option.Icon;
  return (
    <span
      className={`butler-avatar butler-avatar-${avatar} butler-avatar-${size}`}
      role="img"
      aria-label={`${name}的头像`}
      title={option.label}
    >
      <Icon aria-hidden="true" />
    </span>
  );
}

