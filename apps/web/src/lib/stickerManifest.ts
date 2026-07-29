export interface StickerEntry {
  id: string;
  title: string;
  packageId: string;
  packageTitle: string;
  groupId: string;
  groupTitle: string;
  src: string;
  fileName: string;
  mimeType: string;
  tags: string[];
}

export interface StickerGroup {
  id: string;
  title: string;
  packageId: string;
  packageTitle: string;
  items: StickerEntry[];
}

export interface StickerCatalog {
  groups: StickerGroup[];
  entries: StickerEntry[];
}

export interface RawStickerPackageRef {
  id?: string;
  manifest?: string;
}

export interface RawStickerIndex {
  packages?: RawStickerPackageRef[];
}

export interface RawStickerEntry {
  id?: string;
  title?: string;
  src?: string;
  tags?: string[];
}

export interface RawStickerGroup {
  id?: string;
  title?: string;
  items?: RawStickerEntry[];
}

export interface RawStickerPackage {
  id?: string;
  title?: string;
  source?: string;
  license?: string;
  groups?: RawStickerGroup[];
}
