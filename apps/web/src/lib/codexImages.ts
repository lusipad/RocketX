import { t } from '../i18n';

export const MAX_CODEX_IMAGES = 4;
export const MAX_CODEX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_CODEX_IMAGE_TOTAL_BYTES = 25 * 1024 * 1024;

const SUPPORTED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export interface CodexImageInput {
  name: string;
  type: string;
  size: number;
  dataUrl: string;
}

export interface CodexImageAttachment {
  name: string;
  type: string;
}

export interface CodexGeneratedImage {
  id: string;
  name: string;
  dataUrl: string;
  savedPath?: string;
  alt: string;
}

function fileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(t('agent.codexImages.readFailed', { name: file.name })));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

export async function appendCodexImages(
  current: readonly CodexImageInput[],
  files: readonly File[],
): Promise<CodexImageInput[]> {
  const selected = [...current];
  for (const file of files) {
    if (selected.length >= MAX_CODEX_IMAGES) {
      throw new Error(t('agent.codexImages.tooMany', { max: MAX_CODEX_IMAGES }));
    }
    if (!SUPPORTED_IMAGE_TYPES.has(file.type.toLowerCase())) {
      throw new Error(t('agent.codexImages.unsupportedType', { name: file.name }));
    }
    if (file.size > MAX_CODEX_IMAGE_BYTES) {
      throw new Error(t('agent.codexImages.tooLargeSingle', { name: file.name }));
    }
    if (selected.reduce((total, image) => total + image.size, 0) + file.size > MAX_CODEX_IMAGE_TOTAL_BYTES) {
      throw new Error(t('agent.codexImages.tooLargeTotal'));
    }
    selected.push({
      name: file.name,
      type: file.type.toLowerCase(),
      size: file.size,
      dataUrl: await fileDataUrl(file),
    });
  }
  return selected;
}

export function codexImageAttachments(
  images: readonly CodexImageInput[],
): CodexImageAttachment[] {
  return images.map(({ name, type }) => ({ name, type }));
}
