import { ExternalLink, FolderOpen, ImagePlus, Maximize2, X } from 'lucide-react';
import { useEffect, useRef, useState, type ClipboardEvent } from 'react';
import {
  appendCodexImages,
  type CodexGeneratedImage,
  type CodexImageAttachment,
  type CodexImageInput,
} from '../lib/codexImages';
import { isTauriRuntime } from '../lib/client';
import { tr, useUiLocale } from '../lib/uiLocale';
import { openDesktopPath, revealDesktopPath } from '../platform/desktopOpener';
import { toast } from '../stores/toast';

async function openGeneratedImage(image: CodexGeneratedImage): Promise<void> {
  if (isTauriRuntime() && image.savedPath) {
    try {
      await openDesktopPath(image.savedPath);
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
    await revealDesktopPath(image.savedPath);
  } catch (reason) {
    toast.error(reason, '无法定位生成图片');
  }
}

export async function pasteCodexImages(
  event: ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  images: readonly CodexImageInput[],
  onChange: (images: CodexImageInput[]) => void,
  onReadingChange?: (reading: boolean) => void,
): Promise<void> {
  const files = Array.from(event.clipboardData.files);
  if (!files.length) return;
  event.preventDefault();
  onReadingChange?.(true);
  try {
    onChange(await appendCodexImages(images, files));
  } catch (error) {
    toast.error(error, '粘贴图片失败');
  } finally {
    onReadingChange?.(false);
  }
}

export function CodexImageAttachments({
  attachments,
}: {
  attachments?: readonly CodexImageAttachment[];
}) {
  const locale = useUiLocale();
  if (!attachments?.length) return null;
  return (
    <div className="codex-native-message-attachments">
      {attachments.map((attachment, index) => (
        <span key={`${attachment.name}-${index}`}>{tr('图片：', 'Image: ', locale)}{attachment.name}</span>
      ))}
    </div>
  );
}

export function CodexGeneratedImages({
  images,
}: {
  images?: readonly CodexGeneratedImage[];
}) {
  const locale = useUiLocale();
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
      <div className="codex-native-generated-images" aria-label={tr('生成的图片', 'Generated images', locale)}>
        {images.map((image) => (
          <figure key={image.id}>
            <button
              type="button"
              className="codex-native-generated-preview"
              title={`${image.name} · ${tr('点击查看原图', 'Click to view full image', locale)}`}
              aria-label={tr(`预览生成图片 ${image.name}`, `Preview generated image ${image.name}`, locale)}
              onClick={() => setPreviewImage(image)}
            >
              <img src={image.dataUrl} alt={image.alt} />
              <span><Maximize2 size={14} aria-hidden="true" />{tr('查看原图', 'View full size', locale)}</span>
            </button>
            <figcaption>
              <span title={image.savedPath ?? image.name}>{image.name}</span>
              {image.savedPath ? (
                <button type="button" onClick={() => void revealGeneratedImage(image)}>
                  <FolderOpen size={13} aria-hidden="true" />
                  {tr('打开所在位置', 'Reveal in folder', locale)}
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
          aria-label={tr(`查看生成图片 ${previewImage.name}`, `View generated image ${previewImage.name}`, locale)}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPreviewImage(null);
          }}
        >
          <div>
            <header>
              <div>
                <strong>{previewImage.name}</strong>
                <span title={previewImage.savedPath}>{previewImage.savedPath ?? tr('此图片尚未保存为本地文件', 'Image has not been saved as a local file', locale)}</span>
              </div>
              <div>
                {previewImage.savedPath ? (
                  <button type="button" onClick={() => void revealGeneratedImage(previewImage)}>
                    <FolderOpen size={14} aria-hidden="true" />
                    {tr('打开所在位置', 'Reveal in folder', locale)}
                  </button>
                ) : null}
                <button type="button" onClick={() => void openGeneratedImage(previewImage)}>
                  <ExternalLink size={14} aria-hidden="true" />
                  {previewImage.savedPath ? tr('系统打开', 'Open with system viewer', locale) : tr('下载图片', 'Download image', locale)}
                </button>
                <button ref={closeRef} type="button" aria-label={tr('关闭图片预览', 'Close image preview', locale)} onClick={() => setPreviewImage(null)}>
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
  const locale = useUiLocale();
  if (!images.length) return null;
  return (
    <div className="codex-native-image-previews" aria-label={tr('待发送图片', 'Pending images', locale)}>
      {images.map((image, index) => (
        <div key={`${image.name}-${index}`} title={image.name}>
          <img src={image.dataUrl} alt={image.name} />
          <button
            type="button"
            aria-label={tr(`移除图片 ${image.name}`, `Remove image ${image.name}`, locale)}
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
  onReadingChange,
}: {
  images: readonly CodexImageInput[];
  onChange: (images: CodexImageInput[]) => void;
  disabled?: boolean;
  onReadingChange?: (reading: boolean) => void;
}) {
  const locale = useUiLocale();
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    onReadingChange?.(true);
    try {
      onChange(await appendCodexImages(images, Array.from(files)));
    } catch (error) {
      toast.error(error, tr('添加图片失败', 'Could not attach image', locale));
    } finally {
      onReadingChange?.(false);
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
        disabled={disabled}
        hidden
        aria-label={tr('选择图片', 'Choose image', locale)}
        onChange={(event) => void addFiles(event.target.files)}
      />
      <button
        type="button"
        aria-label={tr('添加图片', 'Attach image', locale)}
        title={tr('添加图片', 'Attach image', locale)}
        disabled={disabled}
        className="codex-native-tool-button"
        onClick={() => inputRef.current?.click()}
      >
        <ImagePlus size={15} aria-hidden="true" />
      </button>
    </>
  );
}
