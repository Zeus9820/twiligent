import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import StatusBadge from './StatusBadge';
import { ACTIVE_BULK, BULK_STATUS } from './publishConstants';
import { fileSizeMb, isVideoFile } from './queueHelpers.ts';
import type { QueueItem } from './queueHelpers.ts';

interface BulkFileItemProps {
  item: QueueItem;
  position: number;
  processing: boolean;
  youtubeEnabled: boolean;
  onCaptionChange: (id: number, caption: string) => void;
  onYouTubeTitleChange: (id: number, title: string) => void;
  onYouTubeDescriptionChange: (id: number, description: string) => void;
  onRemove: (id: number) => void;
}

export default function BulkFileItem({ item, position, processing, youtubeEnabled, onCaptionChange, onYouTubeTitleChange, onYouTubeDescriptionChange, onRemove }: BulkFileItemProps) {
  const isActive = ACTIVE_BULK.includes(item.status);
  return (
    <li className={cn('flex items-start gap-3 rounded-field border p-3', isActive ? 'border-brand/40 bg-brand-soft/20' : 'border-line')}>
      <div className="relative size-14 shrink-0 overflow-hidden rounded-control bg-surface-sunken">
        {isVideoFile(item.file)
          ? <video src={item.preview} muted className="size-full object-cover" />
          : <img src={item.preview} alt="" className="size-full object-cover" />}
        <span className="absolute top-0.5 left-0.5 rounded-sm bg-media-scrim/75 px-1 font-mono text-[0.5625rem] font-semibold text-on-media">{position}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className="truncate text-sm font-medium text-ink">{item.file.name}</span>
          <span className="shrink-0 text-caption text-ink-faint">{fileSizeMb(item.file, 1)} MB</span>
        </div>
        {item.status === 'pending' || item.status === 'error' ? (
          <Textarea value={item.caption} onChange={e => onCaptionChange(item.id, e.target.value)} placeholder={`Caption for file ${position}`} rows={1} className="min-h-9 text-small" aria-label={`Caption for file ${position}`} />
        ) : (
          <p className="truncate text-caption text-ink-muted">{item.caption || 'No caption'}</p>
        )}
        {youtubeEnabled && (item.status === 'pending' || item.status === 'error') && <div className="mt-2 flex flex-col gap-1.5">
          <input value={item.youtubeTitle} onChange={event => onYouTubeTitleChange(item.id, event.target.value)} maxLength={100} disabled={processing} aria-label={`YouTube title for file ${position}`} className="h-9 rounded-control border border-line bg-surface px-2 text-small" placeholder={`YouTube title for file ${position}`} />
          <Textarea value={item.youtubeDescription} onChange={event => onYouTubeDescriptionChange(item.id, event.target.value)} disabled={processing} rows={1} aria-label={`YouTube description for file ${position}`} className="min-h-9 text-small" placeholder="YouTube description" />
        </div>}
        {(item.status === 'uploading' || item.status === 'uploaded') && <Progress value={item.progress} className="mt-1.5" aria-label={`Upload progress for file ${position}`} />}
        {item.error && <p className="mt-1 text-caption text-danger">Error: {item.error}</p>}
        {item.mediaId && <p className="mt-1 font-mono text-caption text-success">Media ID {item.mediaId}</p>}
        {item.youtubeVideoId && <a className="mt-1 block text-caption text-brand-text underline" href={`https://www.youtube.com/watch?v=${encodeURIComponent(item.youtubeVideoId)}`} target="_blank" rel="noopener noreferrer">View YouTube Short</a>}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {isActive && <Spinner className="size-3.5 text-brand" />}
        <StatusBadge status={item.status} map={BULK_STATUS} />
        {item.status === 'pending' && !processing && (
          <Button variant="ghost" size="icon-xs" onClick={() => onRemove(item.id)} aria-label={`Remove ${item.file.name}`}><X /></Button>
        )}
      </div>
    </li>
  );
}
