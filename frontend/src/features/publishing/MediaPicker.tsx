import { Upload, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import SurfaceBox from '@/components/SurfaceBox';
import { cn } from '@/lib/utils';
import TypePicker from './TypePicker';
import { fileSizeMb, isVideoFile } from './queueHelpers.ts';
import type { ContentTypeOption } from './publishConstants';
import type { SinglePostForm } from './useSinglePostForm';

interface MediaPreviewProps {
  file: File;
  filePreview: string;
  selectedType: ContentTypeOption | undefined;
  onClear: () => void;
}

interface MediaPickerProps {
  form: SinglePostForm;
  selectedType: ContentTypeOption | undefined;
}

function MediaPreview({ file, filePreview, selectedType, onClear }: MediaPreviewProps) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
      <div className="relative w-full shrink-0 overflow-hidden rounded-control bg-surface-sunken sm:w-52">
        {isVideoFile(file) ? (
          <video src={filePreview} controls muted className="max-h-72 w-full bg-media-scrim object-contain" />
        ) : (
          <img src={filePreview} alt="Selected media preview" className="max-h-72 w-full object-contain" />
        )}
        <button
          type="button"
          onClick={onClear}
          aria-label="Remove file"
          className="absolute top-2 right-2 flex size-7 items-center justify-center rounded-full bg-media-scrim/75 text-on-media transition-colors hover:bg-brand"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-ink">{file.name}</p>
        <p className="text-small text-ink-muted">{fileSizeMb(file, 2)} MB, {file.type}</p>
        <Badge variant="default" className="mt-2">{selectedType?.label}</Badge>
      </div>
    </div>
  );
}

export default function MediaPicker({ form, selectedType }: MediaPickerProps) {
  const { contentType, file, fileInputRef } = form;
  return (
    <SurfaceBox title="Media" subheader={selectedType ? selectedType.desc : 'Choose what you are posting, then add the file.'}>
      <div className="flex flex-col gap-4">
        <TypePicker value={contentType} onChange={form.changeContentType} />
        {file ? (
          <MediaPreview file={file} filePreview={form.filePreview as string} selectedType={selectedType} onClear={form.clearFile} />
        ) : (
          <div
            className={cn(
              'relative flex w-full flex-col items-center gap-2 rounded-card border border-dashed p-10 text-center transition-colors duration-(--duration-fast) focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              contentType ? 'border-line-strong/50 hover:border-brand hover:bg-brand-soft/30' : 'cursor-not-allowed border-line opacity-60',
            )}
          >
            <input ref={fileInputRef} type="file" accept={selectedType?.accept || 'video/mp4,video/quicktime'} onChange={form.handleFileSelect} disabled={!contentType} aria-label="Choose a video or photo file" className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed" />
            <Upload className="size-8 stroke-[1.5] text-ink-faint" />
            <span className="text-sm font-medium text-ink">{contentType ? 'Choose a file' : 'Choose a content type first'}</span>
            {selectedType && <span className="text-caption text-ink-faint">{selectedType.desc}</span>}
          </div>
        )}
      </div>
    </SurfaceBox>
  );
}
