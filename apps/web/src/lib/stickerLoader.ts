import type {
  RawStickerEntry,
  RawStickerGroup,
  RawStickerIndex,
  RawStickerPackage,
  StickerCatalog,
  StickerEntry,
  StickerGroup,
} from './stickerManifest';

export const DEFAULT_STICKER_INDEX_URL = '/stickers/index.json';

type FetchLike = (input: string) => Promise<Response>;

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => asNonEmptyString(item)).filter((item): item is string => !!item)
    : [];
}

function absoluteUrl(url: string, baseUrl?: string): string | null {
  try {
    return new URL(
      url,
      baseUrl ?? (typeof location === 'undefined' ? 'https://rocketx.invalid/' : location.href),
    ).toString();
  } catch {
    return null;
  }
}

function resolveAssetUrl(path: string, baseUrl?: string): string | null {
  if (!path.trim()) return null;
  const resolved = absoluteUrl(path, baseUrl);
  if (!resolved) return null;
  if (baseUrl && !isUrlInsideDirectory(resolved, baseUrl)) return null;
  return resolved;
}

function isUrlInsideDirectory(candidate: string, parentFile: string): boolean {
  const candidateUrl = new URL(candidate);
  const parentDirectory = new URL('.', parentFile);
  return candidateUrl.origin === parentDirectory.origin
    && candidateUrl.pathname.startsWith(parentDirectory.pathname);
}

function fileNameFromUrl(path: string, fallbackId: string): string {
  try {
    const url = new URL(path, 'https://rocketx.invalid');
    const tail = url.pathname.split('/').pop()?.trim();
    return tail || fallbackId;
  } catch {
    const tail = path.split('/').pop()?.trim();
    return tail || fallbackId;
  }
}

export function inferStickerMimeType(path: string): string | null {
  const normalized = path.split('?')[0].toLowerCase();
  if (normalized.endsWith('.png')) return 'image/png';
  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) return 'image/jpeg';
  if (normalized.endsWith('.webp')) return 'image/webp';
  if (normalized.endsWith('.gif')) return 'image/gif';
  if (normalized.endsWith('.bmp')) return 'image/bmp';
  return null;
}

function sanitizeEntry(
  rawEntry: RawStickerEntry,
  context: { packageId: string; packageTitle: string; groupId: string; groupTitle: string; baseUrl?: string },
): StickerEntry | null {
  const id = asNonEmptyString(rawEntry?.id);
  const title = asNonEmptyString(rawEntry?.title);
  const src = asNonEmptyString(rawEntry?.src);
  if (!id || !title || !src) return null;
  const resolvedSrc = resolveAssetUrl(src, context.baseUrl);
  if (!resolvedSrc) return null;
  const mimeType = inferStickerMimeType(resolvedSrc);
  if (!mimeType) return null;
  return {
    id,
    title,
    packageId: context.packageId,
    packageTitle: context.packageTitle,
    groupId: context.groupId,
    groupTitle: context.groupTitle,
    src: resolvedSrc,
    fileName: fileNameFromUrl(resolvedSrc, `${id}${mimeType === 'image/png' ? '.png' : mimeType === 'image/webp' ? '.webp' : '.gif'}`),
    mimeType,
    tags: asStringList(rawEntry?.tags),
  };
}

function sanitizeGroup(
  rawGroup: RawStickerGroup,
  context: { packageId: string; packageTitle: string; baseUrl?: string },
): StickerGroup | null {
  const title = asNonEmptyString(rawGroup?.title);
  if (!title || !Array.isArray(rawGroup?.items)) return null;
  const groupId = asNonEmptyString(rawGroup?.id) ?? title;
  const items = rawGroup.items
    .map((item) =>
      sanitizeEntry(item, {
        packageId: context.packageId,
        packageTitle: context.packageTitle,
        groupId,
        groupTitle: title,
        baseUrl: context.baseUrl,
      }),
    )
    .filter((item): item is StickerEntry => !!item);
  if (items.length === 0) return null;
  return {
    id: groupId,
    title,
    packageId: context.packageId,
    packageTitle: context.packageTitle,
    items,
  };
}

function sanitizePackage(rawPackage: RawStickerPackage, baseUrl?: string): StickerGroup[] {
  const packageId = asNonEmptyString(rawPackage?.id);
  const packageTitle = asNonEmptyString(rawPackage?.title);
  if (!packageId || !packageTitle || !Array.isArray(rawPackage?.groups)) return [];
  return rawPackage.groups
    .map((group) => sanitizeGroup(group, { packageId, packageTitle, baseUrl }))
    .filter((group): group is StickerGroup => !!group);
}

async function loadFromIndex(indexUrl: string, fetchFn: FetchLike): Promise<StickerCatalog> {
  const resolvedIndexUrl = absoluteUrl(indexUrl) ?? indexUrl;
  const response = await fetchFn(resolvedIndexUrl);
  if (!response.ok) throw new Error(`加载贴纸目录失败（${response.status}）`);
  const rawIndex = (await response.json()) as RawStickerIndex;
  const packageRefs = Array.isArray(rawIndex?.packages) ? rawIndex.packages : [];
  const groups: StickerGroup[] = [];
  for (const rawRef of packageRefs) {
    const manifestPath = asNonEmptyString(rawRef?.manifest);
    if (!manifestPath) continue;
    const manifestUrl = absoluteUrl(manifestPath, resolvedIndexUrl);
    if (
      !manifestUrl
      || !isUrlInsideDirectory(manifestUrl, resolvedIndexUrl)
    ) continue;
    try {
      const manifestResponse = await fetchFn(manifestUrl);
      if (!manifestResponse.ok) continue;
      const rawPackage = (await manifestResponse.json()) as RawStickerPackage;
      groups.push(...sanitizePackage(rawPackage, manifestUrl));
    } catch {
      // 单包损坏时跳过，不能拖垮其他包
    }
  }
  return {
    groups,
    entries: groups.flatMap((group) => group.items),
  };
}

export async function loadStickerCatalog(
  source: string | RawStickerPackage[] = DEFAULT_STICKER_INDEX_URL,
  fetchFn: FetchLike = (input) => fetch(input),
): Promise<StickerCatalog> {
  if (typeof source === 'string') return loadFromIndex(source, fetchFn);
  const groups = source.flatMap((pkg) => sanitizePackage(pkg));
  return {
    groups,
    entries: groups.flatMap((group) => group.items),
  };
}

function searchHaystack(entry: StickerEntry): string {
  return [
    entry.id,
    entry.title,
    entry.packageTitle,
    entry.groupTitle,
    ...entry.tags,
  ].join(' ').toLowerCase();
}

export function searchStickerEntries(catalog: StickerCatalog, keyword: string): StickerEntry[] | null {
  const query = keyword.trim().toLowerCase();
  if (!query) return null;
  const matches = catalog.entries.filter((entry) => searchHaystack(entry).includes(query));
  return matches.sort(
    (a, b) => Number(searchHaystack(b).startsWith(query)) - Number(searchHaystack(a).startsWith(query)),
  );
}

export function stickerEntryKey(
  entry: Pick<StickerEntry, 'packageId' | 'id'>,
): string {
  return JSON.stringify([entry.packageId, entry.id]);
}

export async function fetchStickerFile(
  entry: Pick<StickerEntry, 'src' | 'fileName' | 'mimeType'>,
  fetchFn: FetchLike = (input) => fetch(input),
): Promise<File> {
  const response = await fetchFn(entry.src);
  if (!response.ok) throw new Error(`加载贴纸资源失败（${response.status}）`);
  const blob = await response.blob();
  return new File([blob], entry.fileName, {
    type: blob.type || entry.mimeType || inferStickerMimeType(entry.fileName) || 'application/octet-stream',
  });
}
