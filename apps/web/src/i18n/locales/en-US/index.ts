import type { zhCN } from '../zh-CN';
import { enAgent } from './agent';
import { enAuth } from './auth';
import { enButler } from './butler';
import { enChat } from './chat';
import { enCommon } from './common';
import { enNav } from './nav';
import { enPages } from './pages';
import { enPanels } from './panels';
import { enSettings } from './settings';
import { enWorkbench } from './workbench';

export const enUS = {
  ...enCommon,
  ...enAuth,
  ...enNav,
  ...enChat,
  ...enPanels,
  ...enSettings,
  ...enPages,
  ...enWorkbench,
  ...enButler,
  ...enAgent,
} as const satisfies Record<keyof typeof zhCN, string>;
