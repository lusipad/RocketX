import { zhAgent } from './agent';
import { zhAuth } from './auth';
import { zhButler } from './butler';
import { zhChat } from './chat';
import { zhCommon } from './common';
import { zhNav } from './nav';
import { zhPages } from './pages';
import { zhPanels } from './panels';
import { zhSettings } from './settings';
import { zhWorkbench } from './workbench';

export const zhCN = {
  ...zhCommon,
  ...zhAuth,
  ...zhNav,
  ...zhChat,
  ...zhPanels,
  ...zhSettings,
  ...zhPages,
  ...zhWorkbench,
  ...zhButler,
  ...zhAgent,
} as const;
