import type { ComponentType, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { RcMessage, RcMessageAttachment } from '@rcx/rc-client';

export const EXTENSION_POINTS = [
  'nav.module',
  'panel.right',
  'message.action',
  'message.renderer',
  'composer.command',
  'composer.trigger',
  'composer.action',
  'entity.link',
  'home.widget',
  'room.tab',
  'settings.page',
  'background.task',
] as const;

export type ExtensionPoint = (typeof EXTENSION_POINTS)[number];

export interface NavModuleContribution {
  id: string;
  label: string;
  icon?: LucideIcon;
  iconUrl?: string;
  order?: number;
  render: ComponentType;
}

export interface RightPanelContribution {
  id: string;
  render: ComponentType;
}

export interface MessageActionContext {
  message: RcMessage;
}

export interface MessageActionContribution {
  id: string;
  label: string;
  icon?: LucideIcon;
  run: (context: MessageActionContext) => void | Promise<void>;
}

export interface MessageRendererContext {
  message: RcMessage;
  attachment?: RcMessageAttachment;
}

export interface MessageRendererContribution {
  id: string;
  match: (context: MessageRendererContext) => boolean;
  render: (context: MessageRendererContext) => ReactNode;
}

export interface ComposerCommandContext {
  rid: string;
  params: string;
  tmid?: string;
}

export interface ComposerCommandContribution {
  id: string;
  name: string;
  description: string;
  params?: string;
  run: (context: ComposerCommandContext) => void | Promise<void>;
}

export interface ComposerTriggerContribution {
  id: string;
  prefix: string;
  run: (context: { rid: string; text: string; tmid?: string }) => void | Promise<void>;
}

export interface EntityLinkContribution {
  id: string;
  match: (url: string) => boolean;
  render: (url: string, key: string) => ReactNode;
}

/** M6 只承诺注册表结构，真实用例到达前不为这五类预造 API。 */
export interface ReservedContribution {
  id: string;
  [key: string]: unknown;
}

export interface ExtensionPointMap {
  'nav.module': NavModuleContribution;
  'panel.right': RightPanelContribution;
  'message.action': MessageActionContribution;
  'message.renderer': MessageRendererContribution;
  'composer.command': ComposerCommandContribution;
  'composer.trigger': ComposerTriggerContribution;
  'composer.action': ReservedContribution;
  'entity.link': EntityLinkContribution;
  'home.widget': ReservedContribution;
  'room.tab': ReservedContribution;
  'settings.page': ReservedContribution;
  'background.task': ReservedContribution;
}

export type ContributionFor<P extends ExtensionPoint> = ExtensionPointMap[P];

export interface RegisteredContribution<P extends ExtensionPoint = ExtensionPoint> {
  appId: string;
  point: P;
  contribution: ContributionFor<P>;
}
