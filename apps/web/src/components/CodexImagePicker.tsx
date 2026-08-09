import { ImagePlus, X } from 'lucide-react';
import { useRef, type ClipboardEvent } from 'react';
import {
  appendCodexImages,
  type CodexImageAttachment,
  type CodexImageInput,
} from '../lib/codexImages';
import { toast } from '../stores/toast';

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
