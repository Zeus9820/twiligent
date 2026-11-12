import type { MediaType, ScheduledPostRequest, UserTag } from '../../../../shared/types/domain.ts';
import type { InstagramPublishRequest } from '../../../../shared/types/instagram.ts';
import type { QueueItem } from './queueHelpers.ts';
import type { ScheduleFieldValues } from './scheduleHelpers.ts';

export type ContentTypeValue = Extract<MediaType, 'IMAGE' | 'REELS' | 'STORIES'>;

// the form's text fields, before they are parsed into the request shapes
export interface SinglePostFields extends ScheduleFieldValues {
  caption: string;
  shareToFeed: boolean;
  audioName: string;
  thumbOffset: string;
  locationId: string;
  collaborators: string;
  userTags: string;
  altText: string;
}

export interface BulkSettings {
  account: string;
  publishInstagram?: boolean;
  youtubeAccount?: string;
  youtubePrivacy?: 'private' | 'unlisted' | 'public';
  contentType: ContentTypeValue;
  sharedCaption: string;
  collaborators: string;
  userTags: string;
  locationId: string;
  shareToFeed: boolean;
  scheduleMode: boolean;
  startDate: string;
  startTime: string;
  interval: number;
}

export interface PostDetails {
  mediaType: MediaType;
  mediaUrl: string;
  caption?: string;
  coverUrl?: string | null;
  shareToFeed?: boolean;
  collaborators?: string;
  audioName?: string;
  thumbOffset?: string;
  locationId?: string;
  userTags?: string;
  altText?: string;
}

export interface AccountPostDetails extends PostDetails {
  accountId: string;
}

export interface ScheduledPostDetails extends AccountPostDetails {
  scheduledAt: Date;
}

export interface UploadFailure {
  message: string;
  reason?: 'network' | 'rejected';
  storageMessage?: string;
}

export interface SinglePostCheck {
  selectedAccount: string;
  publishInstagram?: boolean;
  youtubeAccount?: string;
  file: File | null;
  contentType: string;
  hasCloudConfig: boolean;
  fields: ScheduleFieldValues;
  now: Date;
}

export interface BulkStartCheck {
  settings: BulkSettings;
  fileCount: number;
  files?: readonly Pick<File, 'size'>[];
  hasCloudConfig: boolean;
  now: Date;
}

export interface EditPostCheck {
  postId: string | null;
  date: string;
  time: string;
  now: Date;
}

const MINUTE_MS = 60000;
const MAX_REEL_FILE_BYTES = 1_000_000_000;

export function parseUserTags(text: string): UserTag[] {
  return text.split(',').map(entry => {
    const parts = entry.trim().replace(/^@/, '').split(/\s+/);
    return { username: parts[0], x: parts[1] ? parseFloat(parts[1]) : 0.5, y: parts[2] ? parseFloat(parts[2]) : 0.5 };
  }).filter(tag => tag.username);
}

export function parseCollaborators(text: string): string[] {
  return text.split(',').map(name => name.trim()).filter(Boolean);
}

export function buildScheduledPostPayload(post: ScheduledPostDetails): ScheduledPostRequest {
  const { accountId, mediaType, mediaUrl, caption, coverUrl, shareToFeed, collaborators } = post;
  const { audioName, thumbOffset, locationId, userTags, altText, scheduledAt } = post;
  return {
    accountId,
    platform: 'instagram',
    mediaType,
    mediaUrl,
    caption: caption || '',
    coverUrl: coverUrl || null,
    shareToFeed: mediaType === 'REELS' ? shareToFeed : true,
    collaborators: collaborators ? parseCollaborators(collaborators) : [],
    audioName: audioName || '',
    thumbOffset: thumbOffset ? parseInt(thumbOffset, 10) : null,
    locationId: locationId || '',
    userTags: userTags ? parseUserTags(userTags) : [],
    altText: (mediaType === 'IMAGE' && altText) ? altText : '',
    scheduledAt: scheduledAt.toISOString(),
  };
}

export function buildContainerPayload(post: PostDetails): InstagramPublishRequest {
  const { mediaType, mediaUrl, caption, coverUrl, shareToFeed, collaborators } = post;
  const { audioName, thumbOffset, locationId, userTags, altText } = post;
  return {
    mediaType,
    mediaUrl,
    caption: caption || undefined,
    coverUrl: coverUrl || undefined,
    shareToFeed: mediaType === 'REELS' ? shareToFeed : undefined,
    collaborators: collaborators ? parseCollaborators(collaborators) : undefined,
    audioName: audioName || undefined,
    thumbOffset: thumbOffset ? parseInt(thumbOffset, 10) : undefined,
    locationId: locationId || undefined,
    userTags: userTags ? parseUserTags(userTags) : undefined,
    altText: (mediaType === 'IMAGE' && altText) ? altText : undefined,
  };
}

// bulk posts share the queue settings and only carry their own caption
export function bulkPostDetails(settings: BulkSettings, item: Pick<QueueItem, 'caption'>, mediaUrl: string): AccountPostDetails {
  return {
    accountId: settings.account,
    mediaType: settings.contentType,
    mediaUrl,
    caption: item.caption,
    shareToFeed: settings.shareToFeed,
    collaborators: settings.collaborators,
    locationId: settings.locationId,
    userTags: settings.userTags,
  };
}

export function singleUploadMessage(err: UploadFailure): string {
  if (err.reason === 'network') return err.message;
  if (err.reason === 'rejected') return err.storageMessage || 'Upload failed';
  return err.message;
}

export function singlePostError({ selectedAccount, publishInstagram = true, youtubeAccount, file, contentType, hasCloudConfig, fields, now }: SinglePostCheck): string {
  const instagramTarget = publishInstagram && Boolean(selectedAccount);
  if ((!instagramTarget && !youtubeAccount) || !file || !contentType) return 'Choose at least one connected account, a content type and a file before publishing.';
  if (youtubeAccount && contentType !== 'REELS') return 'YouTube Shorts can only be published from a Reel video.';
  if (youtubeAccount && fields.scheduleMode) return 'YouTube Shorts scheduling is not available yet. Turn off scheduling or remove the YouTube destination.';
  if (instagramTarget && contentType === 'REELS' && file.size > MAX_REEL_FILE_BYTES) return 'Reels must be 1 GB or smaller to publish through Instagram.';
  if (instagramTarget && !hasCloudConfig) return 'Media uploads are unavailable. Check the R2 storage setup.';
  if (!fields.scheduleMode) return '';
  if (!fields.scheduleDate || !fields.scheduleTime) return 'Set a date and time for the scheduled post.';
  if (new Date(`${fields.scheduleDate}T${fields.scheduleTime}`) <= now) return 'Pick a time in the future.';
  return '';
}

export function bulkBaseTime(settings: Pick<BulkSettings, 'scheduleMode' | 'startDate' | 'startTime'>): Date | null {
  return settings.scheduleMode ? new Date(`${settings.startDate}T${settings.startTime}`) : null;
}

export function bulkStartError({ settings, fileCount, files, hasCloudConfig, now }: BulkStartCheck): string {
  const instagramTarget = (settings.publishInstagram ?? true) && Boolean(settings.account);
  if ((!instagramTarget && !settings.youtubeAccount) || fileCount === 0 || !settings.contentType) return 'Choose at least one connected account, a content type and at least one file.';
  if (settings.youtubeAccount && settings.contentType !== 'REELS') return 'YouTube Shorts can only be published from Reel videos.';
  if (settings.youtubeAccount && settings.scheduleMode) return 'YouTube Shorts scheduling is not available yet. Turn off scheduling or remove the YouTube destination.';
  if (instagramTarget && settings.contentType === 'REELS' && files?.some(file => file.size > MAX_REEL_FILE_BYTES)) return 'Each Reel must be 1 GB or smaller to publish through Instagram.';
  if (instagramTarget && !hasCloudConfig) return 'Media uploads are unavailable. Check the R2 storage setup.';
  if (settings.scheduleMode && (!settings.startDate || !settings.startTime)) return 'Set a start date and time for the schedule.';
  const baseTime = bulkBaseTime(settings);
  if (baseTime && baseTime <= now) return 'Pick a start time in the future.';
  return '';
}

export function editPostError({ postId, date, time, now }: EditPostCheck): string {
  if (!postId || !date || !time) return 'Set a date and time.';
  if (new Date(`${date}T${time}`) <= now) return 'Pick a time in the future.';
  return '';
}

export function bulkScheduledTime(baseTime: Date, offset: number, intervalMinutes: number): Date {
  return new Date(baseTime.getTime() + offset * intervalMinutes * MINUTE_MS);
}
