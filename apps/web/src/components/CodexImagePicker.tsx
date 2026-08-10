import { ExternalLink, FolderOpen, ImagePlus, Maximize2, X } from 'lucide-react';
import { useEffect, useRef, useState, type ClipboardEvent } from 'react';
import {
  appendCodexImages,
  type CodexGeneratedImage,
  type CodexImageAttachment,
  type CodexImageInput,
} from '../lib/codexImages';
import { isTauriRuntime } from '../lib/client';
import { toast } from '../stores/toast';

async function openGeneratedImage(image: CodexGeneratedImage): Promise<void> {
  if (isTauriRuntime() && image.savedPath) {
    try {
      const { openPath } = await import('@tauri-apps/plugin-opener');
      await openPath(image.savedPath);
      return;
    } catch (reason) {
      toast.error(reason, '无法打开生成图片');
      return;
    }
  }
  const link = document.createElement('a');
  link.href = image.dataUrl;
  link.download = image.name;
  link.click();
}

async function revealGeneratedImage(image: CodexGeneratedImage): Promise<void> {
  if (!image.savedPath) return;
  try {
    const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
    await revealItemInDir(image.savedPath);
  } catch (reason) {
    toast.error(reason, '无法定位生成图片');
  }
}

export async function pasteCodexImages(
  event: ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  images: readonly CodexImageInput[],
  onChange: (images: CodexImageInput[]) => void,
): Promise<void> {
  const files = Array.from(event.clipboardData.files);
  if (!files.length) return;
  event.preventDefault();
  try {
    onChange(await appendCodexImages(images, files));
  } catch (error) {
    toast.error(error, '粘贴图片失败');
  }
}

export function CodexImageAttachments({
  attachments,
}: {
  attachments?: readonly CodexImageAttachment[];
}) {
  if (!attachments?.length) return null;
  return (
    <div className="codex-native-message-attachments">
      {attachments.map((attachment, index) => (
        <span key={`${attachment.name}-${index}`}>图片：{attachment.name}</span>
      ))}
    </div>
  );
}

export function CodexGeneratedImages({
  images,
}: {
  images?: readonly CodexGeneratedImage[];
}) {
  const [previewImage, setPreviewImage] = useState<CodexGeneratedImage | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!previewImage) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewImage(null);
    };
    document.addEventListener('keydown', close);
    requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      document.removeEventListener('keydown', close);
      previousFocus?.focus();
    };
  }, [previewImage]);

  if (!images?.length) return null;
  return (
    <>
      <div className="codex-native-generated-images" aria-label="生成的图片">
        {images.map((image) => (
          <figure key={image.id}>
            <button
              type="button"
              className="codex-native-generated-preview"
              title={`${image.name} · 点击查看原图`}
              aria-label={`预览生成图片 ${image.name}`}
              onClick={() => setPreviewImage(image)}
            >
              <img src={image.dataUrl} alt={image.alt} />
              <span><Maximize2 size={14} aria-hidden="true" />查看原图</span>
            </button>
            <figcaption>
              <span title={image.savedPath ?? image.name}>{image.name}</span>
              {image.savedPath ? (
                <button type="button" onClick={() => void revealGeneratedImage(image)}>
                  <FolderOpen size={13} aria-hidden="true" />
                  打开所在位置
                </button>
              ) : null}
            </figcaption>
          </figure>
        ))}
      </div>
      {previewImage ? (
        <div
          className="codex-native-image-viewer"
          role="dialog"
          aria-modal="true"
          aria-label={`查看生成图片 ${previewImage.name}`}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPreviewImage(null);
          }}
        >
          <div>
            <header>
              <div>
                <strong>{previewImage.name}</strong>
                <span title={previewImage.savedPath}>{previewImage.savedPath ?? '此图片尚未保存为本地文件'}</span>
              </div>
              <div>
                {previewImage.savedPath ? (
                  <button type="button" onClick={() => void revealGeneratedImage(previewImage)}>
                    <FolderOpen size={14} aria-hidden="true" />
                    打开所在位置
                  </button>
                ) : null}
                <button type="button" onClick={() => void openGeneratedImage(previewImage)}>
                  <ExternalLink size={14} aria-hidden="true" />
                  {previewImage.savedPath ? '系统打开' : '下载图片'}
                </button>
                <button ref={closeRef} type="button" aria-label="关闭图片预览" onClick={() => setPreviewImage(null)}>
                  <X size={17} aria-hidden="true" />
                </button>
              </div>
            </header>
            <div className="codex-native-image-viewer-stage">
              <img src={previewImage.dataUrl} alt={previewImage.alt} />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function CodexImagePreviews({
  images,
  onChange,
}: {
  images: readonly CodexImageInput[];
  onChange: (images: CodexImageInput[]) => void;
}) {
  if (!images.length) return null;
  return (
    <div className="codex-native-image-previews" aria-label="待发送图片">
      {images.map((image, index) => (
        <div key={`${image.name}-${index}`} title={image.name}>
          <img src={image.dataUrl} alt={image.name} />
          <button
            type="button"
            aria-label={`移除图片 ${image.name}`}
            onClick={() => onChange(images.filter((_, current) => current !== index))}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}

export default function CodexImagePicker({
  images,
  onChange,
  disabled,
}: {
  images: readonly CodexImageInput[];
  onChange: (images: CodexImageInput[]) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      onChange(await appendCodexImages(images, Array.from(files)));
    } catch (error) {
      toast.error(error, '添加图片失败');
    } finally {
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        hidden
        aria-label="选择图片"
        onChange={(event) => void addFiles(event.target.files)}
      />
      <button
        type="button"
        aria-label="添加图片"
        title="添加图片"
        disabled={disabled}
        className="codex-native-tool-button"
        onClick={() => inputRef.current?.click()}
      >
        <ImagePlus size={15} aria-hidden="true" />
      </button>
    </>
  );
}
