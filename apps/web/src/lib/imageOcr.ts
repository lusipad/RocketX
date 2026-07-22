export interface ImageOcrWord {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  spaceAfter: boolean;
}

export interface ImageOcrResult {
  text: string;
  language: string;
  words: ImageOcrWord[];
}

export function isWindowsDesktopOcr(tauri: boolean, userAgent: string): boolean {
  return tauri && /Windows/i.test(userAgent);
}

function percent(value: number): string {
  return `${Math.round(value * 10_000) / 100}%`;
}

export function ocrWordStyle(word: Pick<ImageOcrWord, 'x' | 'y' | 'width' | 'height'>) {
  const x = Math.min(Math.max(word.x, 0), 1);
  const y = Math.min(Math.max(word.y, 0), 1);
  return {
    left: percent(x),
    top: percent(y),
    width: percent(Math.min(Math.max(word.width, 0), 1 - x)),
    height: percent(Math.min(Math.max(word.height, 0), 1 - y)),
  };
}

async function blobBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export async function recognizeImageBlob(blob: Blob): Promise<ImageOcrResult> {
  if (blob.size > 20 * 1024 * 1024) throw new Error('图片过大，OCR 最大支持 20 MB');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<ImageOcrResult>('image_ocr_recognize', { imageBase64: await blobBase64(blob) });
}
