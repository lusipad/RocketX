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

function fileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取图片 ${file.name}`));
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
      throw new Error(`每次最多发送 ${MAX_CODEX_IMAGES} 张图片`);
    }
    if (!SUPPORTED_IMAGE_TYPES.has(file.type.toLowerCase())) {
      throw new Error(`不支持 ${file.name} 的图片格式，请使用 PNG、JPEG、GIF 或 WebP`);
    }
    if (file.size > MAX_CODEX_IMAGE_BYTES) {
      throw new Error(`${file.name} 超过 10 MiB`);
    }
    if (selected.reduce((total, image) => total + image.size, 0) + file.size > MAX_CODEX_IMAGE_TOTAL_BYTES) {
      throw new Error('本次图片总大小不能超过 25 MiB');
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
