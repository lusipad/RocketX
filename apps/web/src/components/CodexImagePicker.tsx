import { ExternalLink, FolderOpen, ImagePlus, Maximize2, X } from 'lucide-react';
import { useEffect, useRef, useState, type ClipboardEvent } from 'react';
import { t as rawT, useT } from '../i18n';
import {
  appendCodexImages,
  type CodexGeneratedImage,
  type CodexImageAttachment,
  type CodexImageInput,
} from '../lib/codexImages';
import { isTauriRuntime } from '../lib/client';
import { openDesktopPath, revealDesktopPath } from '../platform/desktopOpener';
import { toast } from '../stores/toast';

async function openGeneratedImage(image: CodexGeneratedImage): Promise<void> {
  if (isTauriRuntime() && image.savedPath) {
    try {
      await openDesktopPath(image.savedPath);
      return;
    } catch (reason) {
      toast.error(reason, rawT('agent.imagePicker.openError'));
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
    toast.error(reason, rawT('agent.imagePicker.revealError'));
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
    toast.error(error, rawT('agent.imagePicker.pasteError'));
  } finally {
    onReadingChange?.(false);
  }
}

export function CodexImageAttachments({
  attachments,
}: {
  attachments?: readonly CodexImageAttachment[];
}) {
  const t = useT();
  if (!attachments?.length) return null;
  return (
    <div className="codex-native-message-attachments">
      {attachments.map((attachment, index) => (
        <span key={`${attachment.name}-${index}`}>{t('agent.imagePicker.attachmentLabel', { name: attachment.name })}</span>
      ))}
    </div>
  );
}

export function CodexGeneratedImages({
  images,
}: {
  images?: readonly CodexGeneratedImage[];
}) {
  const t = useT();
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
      <div className="codex-native-generated-images" aria-label={t('agent.imagePicker.generatedImagesAria')}>
        {images.map((image) => (
          <figure key={image.id}>
            <button
              type="button"
              className="codex-native-generated-preview"
              title={t('agent.imagePicker.previewTitle', { name: image.name })}
              aria-label={t('agent.imagePicker.previewAria', { name: image.name })}
              onClick={() => setPreviewImage(image)}
            >
              <img src={image.dataUrl} alt={image.alt} />
              <span><Maximize2 size={14} aria-hidden="true" />{t('agent.imagePicker.viewOriginal')}</span>
            </button>
            <figcaption>
              <span title={image.savedPath ?? image.name}>{image.name}</span>
              {image.savedPath ? (
                <button type="button" onClick={() => void revealGeneratedImage(image)}>
                  <FolderOpen size={13} aria-hidden="true" />
                  {t('agent.imagePicker.revealInFolder')}
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
          aria-label={t('agent.imagePicker.viewingAria', { name: previewImage.name })}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPreviewImage(null);
          }}
        >
          <div>
            <header>
              <div>
                <strong>{previewImage.name}</strong>
                <span title={previewImage.savedPath}>{previewImage.savedPath ?? t('agent.imagePicker.notSavedLocally')}</span>
              </div>
              <div>
                {previewImage.savedPath ? (
                  <button type="button" onClick={() => void revealGeneratedImage(previewImage)}>
                    <FolderOpen size={14} aria-hidden="true" />
                    {t('agent.imagePicker.revealInFolder')}
                  </button>
                ) : null}
                <button type="button" onClick={() => void openGeneratedImage(previewImage)}>
                  <ExternalLink size={14} aria-hidden="true" />
                  {previewImage.savedPath ? t('agent.imagePicker.systemOpen') : t('agent.imagePicker.downloadImage')}
                </button>
                <button ref={closeRef} type="button" className="codex-native-image-viewer-close" aria-label={t('agent.imagePicker.closePreviewAria')} onClick={() => setPreviewImage(null)}>
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
  const t = useT();
  if (!images.length) return null;
  return (
    <div className="codex-native-image-previews" aria-label={t('agent.imagePicker.pendingImagesAria')}>
      {images.map((image, index) => (
        <div key={`${image.name}-${index}`} title={image.name}>
          <img src={image.dataUrl} alt={image.name} />
          <button
            type="button"
            aria-label={t('agent.imagePicker.removeImageAria', { name: image.name })}
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
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    onReadingChange?.(true);
    try {
      onChange(await appendCodexImages(images, Array.from(files)));
    } catch (error) {
      toast.error(error, t('agent.imagePicker.addError'));
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
        aria-label={t('agent.imagePicker.selectImageAria')}
        onChange={(event) => void addFiles(event.target.files)}
      />
      <button
        type="button"
        aria-label={t('agent.imagePicker.addImageAria')}
        title={t('agent.imagePicker.addImageAria')}
        disabled={disabled}
        className="codex-native-tool-button"
        onClick={() => inputRef.current?.click()}
      >
        <ImagePlus size={15} aria-hidden="true" />
      </button>
    </>
  );
}
