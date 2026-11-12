import { api } from '../../services/api';
import { waitUntilReady, wait } from './containerPolling.ts';
import {
  buildContainerPayload, buildScheduledPostPayload, bulkBaseTime, bulkPostDetails, bulkScheduledTime, bulkStartError,
} from './publishHelpers.ts';
import type { MediaStorageConfig } from '../../services/api';
import type { AppContextValue } from '../../context/AppContext';
import type { BulkSettings } from './publishHelpers.ts';
import type { QueueItem, QueueItemPatch } from './queueHelpers.ts';
import type { BulkQueue } from './useBulkQueue';
import { validateYouTubeShort } from './youtubeShortValidation.ts';

export interface BulkPublishOptions {
  queue: BulkQueue;
  settings: BulkSettings;
  cloudConfig: MediaStorageConfig | null;
  showToast: AppContextValue['showToast'];
  onScheduled: () => void;
}

// cloudConfig is set and baseTime is set in schedule mode once bulkStartError passes
interface BulkRun {
  settings: BulkSettings;
  cloudConfig: MediaStorageConfig | null;
  baseTime: Date | null;
  patchFile: (id: number, patch: QueueItemPatch) => void;
  isCancelled: () => boolean;
}

interface QueueTally {
  offset: number;
  succeeded: number;
  failed: number;
}

const CANCELLED = 'cancelled';
const DONE = 'done';

type ItemOutcome = typeof CANCELLED | typeof DONE;
const BETWEEN_FILES_MS = 2000;
const PARALLEL_UPLOADS = 3;

async function scheduleItem(run: BulkRun, item: QueueItem, mediaUrl: string, offset: number): Promise<void> {
  const { settings } = run;
  run.patchFile(item.id, { status: 'scheduling', progress: 100 });
  const scheduledAt = bulkScheduledTime(run.baseTime as Date, offset, settings.interval);
  await api.createScheduledPost(buildScheduledPostPayload({ ...bulkPostDetails(settings, item, mediaUrl), scheduledAt }));
  run.patchFile(item.id, { status: 'scheduled', progress: 100 });
}

async function publishItem(run: BulkRun, item: QueueItem, mediaUrl: string): Promise<ItemOutcome> {
  const { settings } = run;
  run.patchFile(item.id, { status: 'creating', progress: 100 });
  const { containerId } = await api.createIGContainer(settings.account, buildContainerPayload(bulkPostDetails(settings, item, mediaUrl)));
  if (run.isCancelled()) return CANCELLED;
  await waitUntilReady(settings.contentType, containerId, settings.account, {
    onProcessing: () => run.patchFile(item.id, { status: 'processing' }),
  });
  if (run.isCancelled()) return CANCELLED;
  run.patchFile(item.id, { status: 'publishing' });
  const { mediaId } = await api.publishIGContainer(settings.account, containerId, [mediaUrl]);
  run.patchFile(item.id, { status: 'done', mediaId });
  return DONE;
}

async function processItem(run: BulkRun, item: QueueItem, mediaUrl: string, offset: number): Promise<ItemOutcome> {
  if (run.isCancelled()) return CANCELLED;
  if (!run.settings.scheduleMode) {
    if ((run.settings.publishInstagram ?? true) && run.settings.account && !item.mediaId) return publishItem(run, item, mediaUrl);
    run.patchFile(item.id, { status: 'done', progress: 100 });
    return DONE;
  }
  await scheduleItem(run, item, mediaUrl, offset);
  return DONE;
}

async function uploadQueue(run: BulkRun, files: QueueItem[]): Promise<{ failed: number; mediaUrls: Map<number, string> }> {
  let nextIndex = 0;
  let failed = 0;
  const instagramTarget = (run.settings.publishInstagram ?? true) && Boolean(run.settings.account);
  const youtubeTarget = Boolean(run.settings.youtubeAccount);
  const mediaUrls = new Map(files.flatMap(item => item.mediaUrl || item.youtubeVideoId || !instagramTarget ? [[item.id, item.mediaUrl || ''] as const] : []));
  const worker = async () => {
    while (!run.isCancelled()) {
      const index = nextIndex++;
      if (index >= files.length) return;
      const item = files[index];
      const needsInstagramUpload = instagramTarget && !item.mediaUrl;
      const needsYouTubeUpload = youtubeTarget && !item.youtubeVideoId;
      if (!needsInstagramUpload && !needsYouTubeUpload) continue;
      run.patchFile(item.id, { status: 'uploading', progress: 0 });
      let instagramProgress = 0;
      let youtubeProgress = 0;
      const taskCount = Number(needsInstagramUpload) + Number(needsYouTubeUpload);
      const updateProgress = () => run.patchFile(item.id, { progress: Math.round((instagramProgress + youtubeProgress) / taskCount) });
      const tasks: Array<Promise<{ platform: 'instagram'; mediaUrl: string } | { platform: 'youtube'; videoId: string }>> = [];
      if (needsInstagramUpload) tasks.push(api.uploadMedia(item.file, run.cloudConfig as MediaStorageConfig, {
        onProgress: progress => { instagramProgress = progress; updateProgress(); },
        resumeKey: `bulk-ig-${item.id}`,
      }).then(mediaUrl => ({ platform: 'instagram' as const, mediaUrl })));
      if (needsYouTubeUpload) tasks.push(api.uploadYouTubeShort(run.settings.youtubeAccount as string, item.file, {
        title: item.youtubeTitle.trim() || item.file.name.replace(/\.[^.]+$/, '').slice(0, 100),
        description: item.youtubeDescription,
        privacyStatus: run.settings.youtubePrivacy || 'private',
        onProgress: progress => { youtubeProgress = progress; updateProgress(); },
        resumeKey: `bulk-yt-${item.id}`,
      }).then(videoId => ({ platform: 'youtube' as const, videoId })));
      const outcomes = await Promise.allSettled(tasks);
      const completed = outcomes.flatMap(outcome => outcome.status === 'fulfilled' ? [outcome.value] : []);
      const failures = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [(outcome.reason as Error).message] : []);
      const patch: QueueItemPatch = { progress: 100 };
      for (const result of completed) {
        if (result.platform === 'instagram') patch.mediaUrl = result.mediaUrl;
        else patch.youtubeVideoId = result.videoId;
      }
      if (failures.length) {
        mediaUrls.delete(item.id);
        run.patchFile(item.id, { ...patch, status: 'error', error: failures.join('; ') });
        failed++;
      } else {
        patch.status = 'uploaded';
        run.patchFile(item.id, patch);
        mediaUrls.set(item.id, patch.mediaUrl || '');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_UPLOADS, files.length) }, worker));
  return { failed, mediaUrls };
}

// Media uploads run in parallel; Instagram containers are then published sequentially in queue order.
async function runQueue(run: BulkRun, pendingFiles: QueueItem[]): Promise<QueueTally> {
  const upload = await uploadQueue(run, pendingFiles);
  const tally: QueueTally = { offset: 0, succeeded: 0, failed: upload.failed };
  if (run.isCancelled()) return tally;
  const uploadedFiles = pendingFiles.filter(item => upload.mediaUrls.has(item.id));
  for (let i = 0; i < uploadedFiles.length; i++) {
    if (run.isCancelled()) break;
    const item = uploadedFiles[i];
    try {
      const outcome = await processItem(run, item, upload.mediaUrls.get(item.id) as string, tally.offset);
      if (outcome === CANCELLED) break;
      if (run.settings.scheduleMode) tally.offset++;
      tally.succeeded++;
    } catch (err) {
      run.patchFile(item.id, { status: 'error', error: (err as Error).message });
      tally.failed++;
    }
    if (i < uploadedFiles.length - 1 && !run.isCancelled()) await wait(BETWEEN_FILES_MS);
  }
  return tally;
}

export function useBulkPublish({ queue, settings, cloudConfig, showToast, onScheduled }: BulkPublishOptions) {
  const { cancelRef } = queue;

  // the queue and settings are read once, as they are at the moment of the click
  const handleBulkProcess = async () => {
    const error = bulkStartError({ settings, fileCount: queue.files.length, files: queue.files.map(item => item.file), hasCloudConfig: Boolean(cloudConfig), now: new Date() });
    if (error) {
      showToast(error, 'error');
      return;
    }
    const baseTime = bulkBaseTime(settings);
    const pendingFiles = queue.files.filter(item => item.status === 'pending' || item.status === 'uploaded' || item.status === 'error');
    if (settings.youtubeAccount) {
      for (const item of pendingFiles) {
        const shortError = await validateYouTubeShort(item.file);
        if (shortError) { showToast(`${item.file.name}: ${shortError}`, 'error'); return; }
      }
    }
    queue.setProcessing(true);
    cancelRef.current = false;
    const run: BulkRun = { settings, cloudConfig, baseTime, patchFile: queue.patchFile, isCancelled: () => cancelRef.current };
    const tally = await runQueue(run, pendingFiles);
    queue.setProcessing(false);
    if (cancelRef.current) {
      showToast('Bulk upload stopped. Files already processed keep their status.', 'warning');
      return;
    }
    showToast(`Bulk upload finished: ${tally.succeeded} succeeded, ${tally.failed} failed`, tally.succeeded > 0 ? 'success' : 'error');
    if (settings.scheduleMode) onScheduled();
  };

  const stopBulk = () => {
    cancelRef.current = true;
  };

  return { handleBulkProcess, stopBulk };
}

export type BulkPublish = ReturnType<typeof useBulkPublish>;
