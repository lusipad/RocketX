import { ImagePlus, X } from 'lucide-react';
import { useRef, type ClipboardEvent } from 'react';
import {
  appendButlerImages,
  type ButlerImageAttachment,
  type ButlerImageInput,
} from '../lib/butlerImages';
import { toast } from '../stores/toast';

export async function pasteButlerImages(
  event: ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  images: readonly ButlerImageInput[],
  onChange: (images: ButlerImageInput[]) => void,
): Promise<void> {
  const files = Array.from(event.clipboardData.files);
  if (!files.length) return;
  event.preventDefault();
  try {
    onChange(await appendButlerImages(images, files));
  } catch (error) {
    toast.error(error, '粘贴图片失败');
  }
}

export function ButlerImageAttachments({
  attachments,
}: {
  attachments?: readonly ButlerImageAttachment[];
}) {
  if (!attachments?.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {attachments.map((attachment, index) => (
        <span
          key={`${attachment.name}-${index}`}
          className="rounded bg-black/10 px-2 py-0.5 text-xs"
        >
          图片：{attachment.name}
        </span>
      ))}
    </div>
  );
}

export function ButlerImagePreviews({
  images,
  onChange,
}: {
  images: readonly ButlerImageInput[];
  onChange: (images: ButlerImageInput[]) => void;
}) {
  if (!images.length) return null;
  return (
    <div className="flex flex-wrap gap-2 px-1 pb-2" aria-label="待发送图片">
      {images.map((image, index) => (
        <div
          key={`${image.name}-${index}`}
          className="relative h-14 w-14 overflow-hidden rounded-md border border-line bg-fill-1"
          title={image.name}
        >
          <img src={image.dataUrl} alt={image.name} className="h-full w-full object-cover" />
          <button
            type="button"
            aria-label={`移除图片 ${image.name}`}
            onClick={() => onChange(images.filter((_, current) => current !== index))}
            className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/65 text-white"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

export default function ButlerImagePicker({
  images,
  onChange,
  disabled,
  compact = false,
}: {
  images: readonly ButlerImageInput[];
  onChange: (images: ButlerImageInput[]) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      onChange(await appendButlerImages(images, Array.from(files)));
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
        aria-label="选择管家图片"
        onChange={(event) => void addFiles(event.target.files)}
      />
      <button
        type="button"
        aria-label="添加图片"
        title="添加图片"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className={`flex shrink-0 items-center justify-center rounded text-ink-3 hover:bg-fill-hover hover:text-primary disabled:opacity-40 ${
          compact ? 'h-7 w-7' : 'h-9 w-9'
        }`}
      >
        <ImagePlus size={compact ? 15 : 17} />
      </button>
    </>
  );
}
