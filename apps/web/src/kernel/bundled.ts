import intranetLinkEntry from '../../../../plugins/intranet-link/index.html?raw';
import intranetLinkManifest from '../../../../plugins/intranet-link/rcx.app.json?raw';
import type { BundledAppPackage } from './installed';

export const BUNDLED_APPS = [
  {
    manifestText: intranetLinkManifest,
    entryContent: intranetLinkEntry,
  },
] satisfies readonly BundledAppPackage[];
