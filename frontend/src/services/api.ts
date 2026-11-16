import type { CaptionTask, ClipCaptionWord, ClipJob, ClipOptions, ClippingDashboard } from '@shared/types/clipping.ts';
import { supabase } from '../lib/supabase';
import { failureMessage } from '../lib/apiErrors.ts';
import type {
    AccountListResponse, AccountRefreshAllResponse, AccountResponse, ApiFailure, GitHubSettingsRequest,
    GitHubSettingsResponse, HealthResponse, KeysStatusResponse, OverviewResponse, ScheduledPostDeleteAllResponse,
    ScheduledPostListResponse, ScheduledPostRequest, ScheduledPostResponse, ScheduledPostUpdateRequest,
    ScheduledPostUpdateResponse, ScheduledPublishRunResponse, SuccessMessageResponse, SuccessResponse,
    TrackedContentItem, TrackedContentUpdateRequest, YouTubeAccountAddResponse,
} from '@shared/types/domain.ts';
import type {
    MediaStorageConfigResponse, InstagramAnalyticsResponse, InstagramAuthUrlResponse, InstagramContainerStatusResponse,
    InstagramMediaPublishResponse, InstagramMediaResponse, InstagramPublishingLimitResponse, InstagramPublishRequest,
    InstagramPublishResponse, InstagramTokenRefreshResponse,
} from '@shared/types/instagram.ts';
import type { RedditCacheData, RedditPost } from '@shared/types/reddit.ts';
import type {
    AutomationAccountResponse, AutomationActivityItemResponse, AutomationActivityResponse, AutomationOverviewResponse,
    AutomationRuleRequest, AutomationRuleResponse, AutomationRuleUpdateRequest, AutomationStatsResponse, AutomationTestRequest,
    AutomationTestResponse,
} from '@shared/types/automation.ts';
import type {
    ResolveChannelResponse, YouTubeAnalyticsPayload, YouTubeComparisonResponse, YouTubeVideosResponse,
    YouTubeStudioSummary,
} from '@shared/types/youtube.ts';
import type { InboxFilter, InboxPage, InboxSyncResult, InstagramComment, InstagramCommentsPage } from '@shared/types/instagramComments.ts';

const API = import.meta.env.VITE_API_URL || 'http://localhost:8787/api';

// every failure arrives with a 4xx or 5xx status and the ApiFailure body, so a 2xx is always a success
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;

    const res = await fetch(`${API}${path}`, {
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        ...options,
    });
    // a proxy error page is not JSON; the status still explains the failure
    const data = await res.json().catch(() => null) as unknown;
    if (!res.ok) throw new Error(failureMessage(res.status, data as Partial<ApiFailure> | null));
    return data as T;
}

const MEDIA_RETRY_DELAYS = [0, 1000, 3000, 7000, 15000];

export type UploadErrorReason = 'network' | 'rejected';

interface UploadErrorDetails {
    storageMessage?: string;
}

// what uploadMedia rejects with
export type UploadError = Error & UploadErrorDetails & { reason: UploadErrorReason };

export type MediaStorageConfig = MediaStorageConfigResponse;

export interface UploadOptions {
    onProgress?: (percent: number) => void;
    resumeKey?: string;
}

export interface YouTubeShortUploadOptions extends UploadOptions {
    title: string;
    description: string;
    privacyStatus: 'private' | 'unlisted' | 'public';
}

const UPLOAD_ERROR_MESSAGES: Record<UploadErrorReason, string> = {
    network: 'The upload was interrupted. Your progress is saved so you can retry.',
    rejected: 'Upload failed',
};

// callers read the reason and details so each page keeps its own wording
function uploadError(reason: UploadErrorReason, details: UploadErrorDetails = {}): UploadError {
    const detail = reason === 'network' ? details.storageMessage : undefined;
    return Object.assign(new Error(detail ? `${UPLOAD_ERROR_MESSAGES[reason]}. ${detail}` : UPLOAD_ERROR_MESSAGES[reason]), { reason, ...details });
}

interface MultipartPart {
    partNumber: number;
    etag: string;
}

interface MultipartState {
    uploadId: string;
    key: string;
    partSize: number;
    publicUrl: string;
    parts: MultipartPart[];
}

interface XhrResult {
    etag: string;
}

async function putMediaPart(uploadId: string, key: string, partNumber: number, chunk: Blob, onProgress: (loaded: number) => void): Promise<XhrResult> {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Sign in again before uploading media.');
    const url = `${API}/media-uploads/${encodeURIComponent(uploadId)}/parts/${partNumber}?key=${encodeURIComponent(key)}`;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < MEDIA_RETRY_DELAYS.length; attempt++) {
        if (MEDIA_RETRY_DELAYS[attempt]) await new Promise(resolve => setTimeout(resolve, MEDIA_RETRY_DELAYS[attempt]));
        try {
            return await new Promise<XhrResult>((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('PUT', url);
                xhr.setRequestHeader('Authorization', `Bearer ${session.access_token}`);
                xhr.setRequestHeader('Content-Type', 'application/octet-stream');
                xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(event.loaded); };
                xhr.onerror = () => reject(new Error('Network error while sending a media part.'));
                xhr.onload = () => {
                    if (xhr.status < 200 || xhr.status >= 300) {
                        let message = `Storage returned HTTP ${xhr.status}.`;
                        try { message = (JSON.parse(xhr.responseText) as { error?: string; message?: string }).message || message; } catch { /* keep status message */ }
                        reject(new Error(message));
                        return;
                    }
                    try { resolve(JSON.parse(xhr.responseText) as XhrResult); }
                    catch { reject(new Error('Storage returned an invalid part response.')); }
                };
                xhr.send(chunk);
            });
        } catch (error) {
            lastError = error as Error;
        }
    }
    throw lastError || new Error('Media part upload failed.');
}

async function uploadMedia(file: File, _config: MediaStorageConfig, { onProgress, resumeKey }: UploadOptions = {}): Promise<string> {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Sign in again before uploading media.');
    const stateKey = `twiligent-r2-upload:${session.user.id}:${resumeKey || 'file'}:${file.name}:${file.size}:${file.lastModified}:${file.type}`;
    let state: MultipartState | null = null;
    try { state = JSON.parse(localStorage.getItem(stateKey) || 'null') as MultipartState | null; }
    catch { localStorage.removeItem(stateKey); }
    if (!state) {
        const started = await request<{ success: true } & MultipartState>('/media-uploads', {
            method: 'POST', body: JSON.stringify({ fileName: file.name, contentType: file.type || 'application/octet-stream' }),
        });
        state = { uploadId: started.uploadId, key: started.key, partSize: started.partSize, publicUrl: started.publicUrl, parts: [] };
        localStorage.setItem(stateKey, JSON.stringify(state));
    }
    const parts = new Map(state.parts.map(part => [part.partNumber, part]));
    let completedBytes = [...parts.keys()].reduce((sum, number) => sum + Math.min(state!.partSize, file.size - (number - 1) * state!.partSize), 0);
    const totalParts = Math.ceil(file.size / state.partSize);
    for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
        if (parts.has(partNumber)) continue;
        const start = (partNumber - 1) * state.partSize;
        const chunk = file.slice(start, Math.min(start + state.partSize, file.size));
        try {
            const part = await putMediaPart(state.uploadId, state.key, partNumber, chunk, loaded => {
                onProgress?.(Math.round((completedBytes + loaded) / file.size * 100));
            });
            parts.set(partNumber, { partNumber, etag: part.etag });
            state.parts = [...parts.values()].sort((a, b) => a.partNumber - b.partNumber);
            localStorage.setItem(stateKey, JSON.stringify(state));
            completedBytes += chunk.size;
            onProgress?.(Math.round(completedBytes / file.size * 100));
        } catch (error) {
            throw uploadError('network', { storageMessage: (error as Error).message });
        }
    }
    try {
        await request(`/media-uploads/${encodeURIComponent(state.uploadId)}/complete`, {
            method: 'POST', body: JSON.stringify({ key: state.key, parts: [...parts.values()] }),
        });
    } catch (error) {
        throw uploadError('rejected', { storageMessage: (error as Error).message });
    }
    localStorage.removeItem(stateKey);
    onProgress?.(100);
    return state.publicUrl;
}

interface YouTubeUploadResponse { id?: string; error?: { message?: string } }
const YOUTUBE_CHUNK_SIZE = 8 * 1024 * 1024;

function confirmedYouTubeBytes(range: string | null): number {
    const match = range?.match(/bytes=0-(\d+)/);
    return match ? Number(match[1]) + 1 : 0;
}

function youtubeXhr(sessionId: string, appToken: string, chunk: Blob | null, range: string, onProgress: (loaded: number) => void): Promise<{ status: number; confirmedBytes: number; videoId?: string }> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', `${API}/youtube-studio/short-uploads/${encodeURIComponent(sessionId)}`);
        xhr.setRequestHeader('Authorization', `Bearer ${appToken}`);
        xhr.setRequestHeader('Content-Range', range);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(event.loaded); };
        xhr.onerror = () => reject(new Error('The connection to Kratos Studio was interrupted. Retry to resume the upload.'));
        xhr.onload = () => {
            let body: { status?: number; range?: string; videoId?: string; error?: string } = {};
            try { body = JSON.parse(xhr.responseText); } catch { /* report HTTP status */ }
            if (xhr.status >= 200 && xhr.status < 300 && body.status === 308) resolve({ status: 308, confirmedBytes: confirmedYouTubeBytes(body.range || null) });
            else if (xhr.status >= 200 && xhr.status < 300 && body.videoId) resolve({ status: xhr.status, confirmedBytes: -1, videoId: body.videoId });
            else reject(new Error(body.error || `YouTube upload failed (HTTP ${xhr.status}).`));
        };
        xhr.send(chunk);
    });
}

async function uploadYouTubeShort(accountId: string, file: File, { title, description, privacyStatus, onProgress, resumeKey }: YouTubeShortUploadOptions): Promise<string> {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Sign in again before uploading to YouTube.');
    const stateKey = `youtube-short-upload:${session.user.id}:${accountId}:${resumeKey || 'file'}:${file.name}:${file.size}:${file.lastModified}:${title}:${description}:${privacyStatus}`;
    let sessionId = sessionStorage.getItem(stateKey + ':proxy');
    if (!sessionId && sessionStorage.getItem(stateKey)) throw new Error('This video has an earlier upload attempt. Check YouTube Studio before starting a new upload to avoid a duplicate.');
    const resumeExisting = Boolean(sessionId);
    if (!sessionId) {
        const started = await request<{ success: true; sessionId: string }>(`/accounts/${encodeURIComponent(accountId)}/youtube-studio/short-uploads`, {
            method: 'POST', body: JSON.stringify({ title, description, contentType: file.type, size: file.size, privacyStatus }),
        });
        sessionId = started.sessionId;
        sessionStorage.setItem(stateKey + ':proxy', sessionId);
    }

    let offset = 0;
    let result: string | undefined;
    for (let attempt = 0; attempt < 5 && !result; attempt++) {
        try {
            if (attempt > 0 || resumeExisting) {
                const status = await youtubeXhr(sessionId, session.access_token, null, `bytes */${file.size}`, () => undefined);
                if (status.videoId) { result = status.videoId; break; }
                offset = status.confirmedBytes;
            }
            while (offset < file.size) {
                const end = Math.min(offset + YOUTUBE_CHUNK_SIZE, file.size);
                const chunk = file.slice(offset, end, file.type);
                const response = await youtubeXhr(sessionId, session.access_token, chunk, `bytes ${offset}-${end - 1}/${file.size}`, loaded => onProgress?.(Math.round((offset + loaded) / file.size * 100)));
                if (response.videoId) { result = response.videoId; break; }
                if (response.confirmedBytes <= offset || response.confirmedBytes > end) throw new Error('YouTube did not confirm the uploaded chunk. Checking the upload status.');
                offset = response.confirmedBytes;
                onProgress?.(Math.round(offset / file.size * 100));
            }
        } catch (error) {
            if (attempt === 4) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        }
    }
    if (!result) throw new Error('YouTube did not confirm the Short upload. Retry to resume it.');
    sessionStorage.removeItem(stateKey + ':proxy');
    onProgress?.(100);
    return result;
}

// tracked-content screenshots use the same multipart storage path
async function uploadImage(file: File, config: MediaStorageConfig): Promise<string> {
    return uploadMedia(file, config);
}

export interface ManagedVideo { id: string; title: string; description: string; privacyStatus: string }
export const api = {
    getClipping: () => request<ClippingDashboard>('/clipping'),
    getClippingJob: (id: string) => request<{ job: ClipJob }>(`/clipping/jobs/${id}`),
    pairClipProcessor: (code: string) => request<{ success: true }>('/clipping/processors/pair', { method: 'POST', body: JSON.stringify({ code }) }),
    disconnectClipProcessor: (id: string) => request<{ success: true }>(`/clipping/processors/${id}`, { method: 'DELETE' }),
    createClipJob: (input: { id: string; name: string; source: ClipJob['source']; options: ClipOptions }) => request<{ job: ClipJob }>('/clipping/jobs', { method: 'POST', body: JSON.stringify(input) }),
    cancelClipJob: (id: string) => request<{ success: true }>(`/clipping/jobs/${id}/cancel`, { method: 'POST' }),
    retryClipJob: (id: string) => request<{ success: true }>(`/clipping/jobs/${id}/retry`, { method: 'POST' }),
    inspectClipCaptions: (jobId: string, clipId: string) => request<{ task: CaptionTask }>(`/clipping/jobs/${jobId}/clips/${clipId}/captions/inspect`, { method: 'POST' }),
    getClipCaptionTask: (taskId: string) => request<{ task: CaptionTask }>(`/clipping/caption-tasks/${taskId}`),
    renderClipCaptions: (jobId: string, clipId: string, inspectTaskId: string, words: string[]) => request<{ task: CaptionTask }>(`/clipping/jobs/${jobId}/clips/${clipId}/captions/render`, { method: 'POST', body: JSON.stringify({ inspectTaskId, words }) }),
    downloadClip: async (id: string, clipId: string): Promise<Blob> => {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error('Sign in before downloading a clip.');
        const response = await fetch(`${API}/clipping/jobs/${id}/clips/${clipId}`, { headers: { Authorization: `Bearer ${session.access_token}` } });
        if (!response.ok) throw new Error('The clip could not be downloaded. Try again.');
        return response.blob();
    },
    getIGAccountViews: (id: string, start: string, end: string) => request<{ views: number | null; start: string; end: string; timezone: string; fetchedAt: string; source: string }>(`/accounts/${encodeURIComponent(id)}/ig-account-views?start=${start}&end=${end}`),
    analyzePerformance: (id: string, videoIds?: string[]) => request<{ analysis: string; model: string; facts: { fetchedAt: string; videoCount: number; totalViews: number }; evidence: unknown; generatedAt: string }>(`/accounts/${encodeURIComponent(id)}/ai-analysis`, { method: 'POST', body: JSON.stringify({ videoIds }) }),
    generateMetadata: (context: string, frames?: Array<{ time: number; image: string }>) => request<{ title: string; description: string; summary?: string; titles?: string[] }>('/ai/metadata', { method: 'POST', body: JSON.stringify({ context, frames }) }),
    getManagedVideo: (id: string, videoId: string) => request<ManagedVideo>(`/accounts/${id}/youtube-studio/videos/${videoId}`),
    getIGManagement: (id: string) => request<{ canDelete: boolean; canManageComments: boolean }>(`/accounts/${id}/ig-management`),
    setIGComments: (id: string, mediaId: string, enabled: boolean) => request(`/accounts/${id}/ig-media/${mediaId}/comments`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
    deleteIGMedia: (id: string, mediaId: string) => request(`/accounts/${id}/ig-media/${mediaId}`, { method: 'DELETE' }),
    listManagedVideos: (id: string, page = '') => request<{ videos: ManagedVideo[]; nextPageToken: string | null }>(`/accounts/${id}/youtube-studio/videos?pageToken=${encodeURIComponent(page)}`),
    editManagedVideo: (id: string, video: ManagedVideo) => request(`/accounts/${id}/youtube-studio/videos/${video.id}`, { method: 'PUT', body: JSON.stringify(video) }),
    deleteManagedVideo: (id: string, videoId: string) => request(`/accounts/${id}/youtube-studio/videos/${videoId}`, { method: 'DELETE' }),
    health: () => request<HealthResponse>('/health'),

    // Server key status - all keys are env vars, this just returns configured: true/false
    getKeys: () => request<KeysStatusResponse>('/keys'),

    getAccounts: () => request<AccountListResponse>('/accounts'),
    addAccount: (input: string) => request<YouTubeAccountAddResponse>('/accounts', { method: 'POST', body: JSON.stringify({ input }) }),
    deleteAccount: (id: string) => request<SuccessResponse>(`/accounts/${id}`, { method: 'DELETE' }),
    refreshAccount: (id: string) => request<AccountResponse>(`/accounts/${id}/refresh`, { method: 'POST' }),
    refreshAll: () => request<AccountRefreshAllResponse>('/accounts/refresh-all', { method: 'POST' }),

    // Instagram OAuth - gets the auth URL to redirect the browser to
    getInstagramAuthUrl: () => request<InstagramAuthUrlResponse>('/auth/instagram/url'),
    getFacebookPageAuthUrl: (id: string) => request<{ url: string }>(`/accounts/${id}/facebook-page/url`),
    retryFacebookPagePublish: (id: string, mediaUrl: string, caption: string) => request<{ success: true; videoId: string }>(`/accounts/${id}/facebook-page-publish`, { method: 'POST', body: JSON.stringify({ mediaUrl, caption }) }),

    addInstagramAccount: (accessToken: string) => request<AccountResponse>('/accounts/instagram', { method: 'POST', body: JSON.stringify({ accessToken }) }),
    refreshIGToken: (id: string) => request<InstagramTokenRefreshResponse>(`/accounts/${id}/refresh-ig-token`, { method: 'POST' }),
    getIGAnalytics: (id: string) => request<InstagramAnalyticsResponse>(`/accounts/${id}/ig-analytics`),
    getIGMedia: (id: string) => request<InstagramMediaResponse>(`/accounts/${id}/ig-media`),
    getIGInbox: (id: string, filter: InboxFilter, cursor?: string) => request<{ success: true } & InboxPage>(`/accounts/${id}/ig-inbox?filter=${filter}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
    syncIGInbox: (id: string, mode: 'latest' | 'history' = 'latest') => request<{ success: true } & InboxSyncResult>(`/accounts/${id}/ig-inbox/sync?mode=${mode}`, { method: 'POST' }),
    markIGCommentRead: (id: string, commentId: string) => request<{ success: true }>(`/accounts/${id}/ig-inbox/${commentId}/read`, { method: 'POST' }),
    getIGComments: (id: string, mediaId: string, after?: string) => request<{ success: true } & InstagramCommentsPage>(`/accounts/${id}/ig-comments?mediaId=${encodeURIComponent(mediaId)}${after ? `&after=${encodeURIComponent(after)}` : ''}`),
    suggestIGCommentReply: (id: string, mediaId: string, commentId: string) => request<{ success: true; suggestion: string }>(`/accounts/${id}/ig-comments/suggest-reply`, { method: 'POST', body: JSON.stringify({ mediaId, commentId }) }),
    replyToIGComment: (id: string, mediaId: string, commentId: string, text: string) => request<{ success: true; comment: InstagramComment }>(`/accounts/${id}/ig-comments/reply`, { method: 'POST', body: JSON.stringify({ mediaId, commentId, text }) }),

    // Channel URL/ID resolution
    resolveChannel: (input: string) => request<ResolveChannelResponse>('/resolve-channel', { method: 'POST', body: JSON.stringify({ input }) }),

    // Analytics (YouTube)
    getAnalytics: (id: string) => request<YouTubeAnalyticsPayload>(`/accounts/${id}/analytics`),
    getYouTubeStudioUrl: (id: string) => request<{ url: string }>(`/accounts/${id}/youtube-studio/connect`),
    getYouTubeStudio: (id: string) => request<{ success: true; data: YouTubeStudioSummary }>(`/accounts/${id}/youtube-studio`),
    uploadYouTubeShort,
    getVideos: (id: string) => request<YouTubeVideosResponse>(`/accounts/${id}/videos`),

    getComparison: () => request<YouTubeComparisonResponse>('/comparison'),

    getMediaStorageConfig: () => request<MediaStorageConfigResponse>('/media-storage-config'),
    uploadMedia,
    uploadImage,

    // Instagram Publishing
    getIGPublishingLimit: (id: string) => request<InstagramPublishingLimitResponse>(`/accounts/${id}/ig-publishing-limit`),
    createIGContainer: (id: string, data: InstagramPublishRequest) => request<InstagramPublishResponse>(`/accounts/${id}/ig-publish`, { method: 'POST', body: JSON.stringify(data) }),
    getIGContainerStatus: (containerId: string, accountId: string) => request<InstagramContainerStatusResponse>(`/ig-container/${containerId}/status?accountId=${accountId}`),
    publishIGContainer: (id: string, containerId: string, mediaUrls: string[] = [], facebookPost?: { mediaUrl: string; caption: string; mediaType: string }) => request<InstagramMediaPublishResponse>(`/accounts/${id}/ig-media-publish`, { method: 'POST', body: JSON.stringify({ containerId, mediaUrls, ...facebookPost }) }),

    addRedditAccount: (username: string, cookie: string) => request<AccountResponse>('/accounts/reddit', { method: 'POST', body: JSON.stringify({ username, cookie }) }),
    getRedditAnalytics: (id: string) => request<RedditCacheData>(`/accounts/${id}/reddit-analytics`),
    getRedditPosts: (id: string) => request<RedditPost[]>(`/accounts/${id}/reddit-posts`),

    // Overview dashboard (tracked content + per-account analytics cache)
    getOverview: () => request<OverviewResponse>('/overview'),

    // Tracked Content (Reddit posts and YouTube videos)
    getTrackedContent: () => request<TrackedContentItem[]>('/tracked-content'),
    addTrackedContent: (url: string, accountId: string | null, label: string, category: string) => request<TrackedContentItem>('/tracked-content', { method: 'POST', body: JSON.stringify({ url, accountId, label, category }) }),
    updateTrackedContent: (id: string, updates: TrackedContentUpdateRequest) => request<TrackedContentItem>(`/tracked-content/${id}`, { method: 'PUT', body: JSON.stringify(updates) }),
    deleteTrackedContent: (id: string) => request<SuccessResponse>(`/tracked-content/${id}`, { method: 'DELETE' }),
    refreshTrackedContent: (id: string) => request<TrackedContentItem>(`/tracked-content/${id}/refresh`, { method: 'POST' }),

    // GitHub settings
    getGithubSettings: () => request<GitHubSettingsResponse>('/settings/github'),
    saveGithubSettings: (data: GitHubSettingsRequest) => request<SuccessResponse>('/settings/github', { method: 'PUT', body: JSON.stringify(data) }),

    getScheduledPosts: () => request<ScheduledPostListResponse>('/scheduled-posts'),
    createScheduledPost: (data: ScheduledPostRequest) => request<ScheduledPostResponse>('/scheduled-posts', { method: 'POST', body: JSON.stringify(data) }),
    updateScheduledPost: (id: string, data: ScheduledPostUpdateRequest) => request<ScheduledPostUpdateResponse>(`/scheduled-posts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteScheduledPost: (id: string) => request<SuccessMessageResponse>(`/scheduled-posts/${id}`, { method: 'DELETE' }),
    deleteAllScheduledPosts: () => request<ScheduledPostDeleteAllResponse>('/scheduled-posts', { method: 'DELETE' }),
    processScheduled: () => request<ScheduledPublishRunResponse>('/process-scheduled'),

    // Comment-to-DM automation; activity and stats take filters as query parameters
    getAutomations: () => request<AutomationOverviewResponse>('/automations'),
    createAutomationRule: (data: AutomationRuleRequest) => request<AutomationRuleResponse>('/automations/rules', { method: 'POST', body: JSON.stringify(data) }),
    updateAutomationRule: (id: string, data: AutomationRuleUpdateRequest) => request<AutomationRuleResponse>(`/automations/rules/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    duplicateAutomationRule: (id: string) => request<AutomationRuleResponse>(`/automations/rules/${id}/duplicate`, { method: 'POST' }),
    deleteAutomationRule: (id: string) => request<SuccessMessageResponse>(`/automations/rules/${id}`, { method: 'DELETE' }),
    testAutomationRule: (data: AutomationTestRequest) => request<AutomationTestResponse>('/automations/test', { method: 'POST', body: JSON.stringify(data) }),
    getAutomationActivity: (query: URLSearchParams) => request<AutomationActivityResponse>(`/automations/activity?${query}`),
    retryAutomationActivity: (id: string) => request<AutomationActivityItemResponse>(`/automations/activity/${id}/retry`, { method: 'POST' }),
    retryAutomationPublicReply: (id: string) => request<AutomationActivityItemResponse>(`/automations/activity/${id}/public-reply/retry`, { method: 'POST' }),
    getAutomationStats: (query: URLSearchParams) => request<AutomationStatsResponse>(`/automations/stats?${query}`),
    setAutomationAccountPaused: (accountId: string, paused: boolean) => request<AutomationAccountResponse>(`/automations/accounts/${accountId}`, { method: 'PUT', body: JSON.stringify({ paused }) }),
    subscribeAutomationAccount: (accountId: string) => request<AutomationAccountResponse>(`/automations/accounts/${accountId}/subscribe`, { method: 'POST' }),
};
