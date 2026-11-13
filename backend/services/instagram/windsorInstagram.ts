import { UpstreamError, ValidationError } from '../../lib/errors.ts';
import { callWindsorTool } from './windsorClient.ts';
import type { InstagramMedia, InstagramProfile, InstagramPublishRequest } from '../../../shared/types/instagram.ts';

type Row = Record<string, unknown>;
const PROFILE_FIELDS = ['account_id', 'user_name', 'followers_count', 'follows_count', 'media_count', 'biography', 'website'];
const MEDIA_FIELDS = ['media_id', 'media_type', 'media_caption', 'media_permalink', 'media_url', 'timestamp', 'media_like_count', 'media_comments_count', 'media_views', 'media_reach'];

function rows(value: unknown): Row[] {
    if (!value || typeof value !== 'object') throw new UpstreamError('Windsor returned an invalid Instagram report.');
    const result = value as { status?: string; data?: unknown };
    if (result.status === 'pending') throw new UpstreamError('Windsor is preparing this Instagram report. Please try again shortly.');
    if (result.status !== 'done' || !Array.isArray(result.data)) throw new UpstreamError('Windsor returned an invalid Instagram report.');
    return result.data.filter((item): item is Row => !!item && typeof item === 'object' && !Array.isArray(item));
}

function string(value: unknown): string { return typeof value === 'string' ? value : ''; }
function number(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0; }

async function report(key: string, accountId: string, fields: string[], datePreset: string, signal?: AbortSignal): Promise<Row[]> {
    return rows(await callWindsorTool(key, 'get_data', { connector: 'instagram', accounts: [accountId], fields, date_preset: datePreset }, signal));
}

export async function fetchWindsorProfile(key: string, accountId: string, signal?: AbortSignal): Promise<InstagramProfile> {
    const [item] = await report(key, accountId, PROFILE_FIELDS, 'last_7d', signal);
    if (!item || !string(item.user_name)) throw new UpstreamError('Windsor returned no Instagram profile for this account.');
    return { igUserId: accountId, username: string(item.user_name), name: string(item.user_name), profilePictureUrl: '',
        followersCount: number(item.followers_count), followsCount: number(item.follows_count), mediaCount: number(item.media_count),
        biography: string(item.biography), website: string(item.website) };
}

export async function fetchWindsorMedia(key: string, accountId: string, signal?: AbortSignal): Promise<InstagramMedia[]> {
    let items: Row[];
    try {
        items = await report(key, accountId, MEDIA_FIELDS, 'last_2years', signal);
    } catch (error) {
        if (!(error instanceof UpstreamError) || error.reason !== 'windsor_trial_history_limit') throw error;
        items = await report(key, accountId, MEDIA_FIELDS, 'last_30d', signal);
    }
    return items.filter(item => string(item.media_id)).map((item): InstagramMedia => {
        const mediaType = string(item.media_type).toUpperCase();
        const contentType = mediaType === 'REELS' || mediaType === 'REEL' || /instagram\.com\/reels?\//i.test(string(item.media_permalink)) ? 'reel' : mediaType === 'VIDEO' ? 'video' : 'post';
        return { id: string(item.media_id), caption: string(item.media_caption), contentType, mediaType, mediaUrl: string(item.media_url),
            thumbnailUrl: contentType === 'post' ? string(item.media_url) : '', permalink: string(item.media_permalink), timestamp: string(item.timestamp),
            likeCount: number(item.media_like_count), commentsCount: number(item.media_comments_count),
            viewCount: item.media_views !== null && item.media_views !== undefined && String(item.media_views).trim() !== '' && Number.isFinite(Number(item.media_views)) && Number(item.media_views) >= 0 ? Number(item.media_views) : null };
    }).sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0));
}

export async function publishWindsorPost(key: string, accountId: string, post: InstagramPublishRequest, signal?: AbortSignal): Promise<unknown> {
    if (!post.mediaUrl) throw new ValidationError('A media URL is required.');
    if (post.collaborators?.length || post.locationId || post.userTags?.length || post.audioName || post.altText) {
        throw new ValidationError('Windsor does not support the selected tags, location, collaborators, audio name, or alt text.');
    }
    const mediaUrl = post.mediaUrl;
    const caption = post.caption || '';
    let action: string;
    let params: Record<string, string | number | boolean>;
    if (post.mediaType === 'REELS' || post.mediaType === 'VIDEO') {
        if (post.coverUrl && post.thumbOffset != null) throw new ValidationError('Choose either a cover image or a thumbnail offset.');
        action = 'create_video_post'; params = { video_url: mediaUrl, caption };
        if (post.coverUrl) params.cover_url = post.coverUrl;
        if (post.shareToFeed !== undefined) params.share_to_feed = post.shareToFeed;
        if (post.thumbOffset != null) params.thumb_offset = post.thumbOffset;
    } else if (post.mediaType === 'STORIES') {
        if (caption) throw new ValidationError('Windsor does not support captions on Stories.');
        action = 'create_story'; params = /\.(mp4|mov)(?:\?|$)/i.test(mediaUrl) ? { video_url: mediaUrl } : { image_url: mediaUrl };
    } else if (!post.mediaType || post.mediaType === 'IMAGE') {
        action = 'create_image_post'; params = { image_url: mediaUrl, caption };
    } else throw new ValidationError('This media type is not supported by this Windsor publishing flow.');
    return callWindsorTool(key, 'execute_action', { connector: 'instagram', account: accountId, action, params }, signal);
}
