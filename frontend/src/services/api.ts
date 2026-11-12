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

function youtubeXhr(uploadUrl: string, accessToken: string, chunk: Blob | null, range: string, onProgress: (loaded: number) => void): Promise<{ status: number; confirmedBytes: number; videoId?: string; message?: string }> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', uploadUrl);
        xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
        xhr.setRequestHeader('Content-Range', range);
        if (chunk) xhr.setRequestHeader('Content-Type', chunk.type || 'application/octet-stream');
        xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(event.loaded); };
        xhr.onerror = () => reject(new Error('YouTube upload connection interrupted.'));
        xhr.onload = () => {
            const status = xhr.status;
            if (status === 308) {
                resolve({ status, confirmedBytes: confirmedYouTubeBytes(xhr.getResponseHeader('Range')) });
                return;
            }
            let body: YouTubeUploadResponse = {};
            try { body = JSON.parse(xhr.responseText) as YouTubeUploadResponse; } catch { /* report status */ }
            if (status >= 200 && status < 300 && body.id) resolve({ status, confirmedBytes: -1, videoId: body.id });
            else reject(new Error(body.error?.message || `YouTube upload failed (HTTP ${status}).`));
        };
        xhr.send(chunk);
    });
}

async function uploadYouTubeShort(accountId: string, file: File, { title, description, privacyStatus, onProgress, resumeKey }: YouTubeShortUploadOptions): Promise<string> {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Sign in again before uploading to YouTube.');
    const stateKey = `youtube-short-upload:${session.user.id}:${accountId}:${resumeKey || 'file'}:${file.name}:${file.size}:${file.lastModified}:${title}:${description}:${privacyStatus}`;
    let uploadUrl: string | null = null;
    let accessToken: string | null = null;
    try {
        const saved = JSON.parse(sessionStorage.getItem(stateKey) || 'null') as { uploadUrl?: string; accessToken?: string } | null;
        uploadUrl = saved?.uploadUrl || null;
        accessToken = saved?.accessToken || null;
    } catch { sessionStorage.removeItem(stateKey); }
    if (!uploadUrl) {
        const started = await request<{ success: true; uploadUrl: string; accessToken: string }>(`/accounts/${encodeURIComponent(accountId)}/youtube-studio/short-uploads`, {
            method: 'POST', body: JSON.stringify({ title, description, contentType: file.type, size: file.size, privacyStatus }),
        });
        uploadUrl = started.uploadUrl;
        accessToken = started.accessToken;
        sessionStorage.setItem(stateKey, JSON.stringify({ uploadUrl, accessToken }));
    }

    let offset = 0;
    let result: string | undefined;
    for (let attempt = 0; attempt < 5 && !result; attempt++) {
        try {
            if (attempt > 0) {
                const status = await youtubeXhr(uploadUrl, accessToken as string, null, `bytes */${file.size}`, () => undefined);
                if (status.videoId) { result = status.videoId; break; }
                offset = status.confirmedBytes;
            }
            while (offset < file.size) {
                const end = Math.min(offset + YOUTUBE_CHUNK_SIZE, file.size);
                const chunk = file.slice(offset, end, file.type);
                const response = await youtubeXhr(uploadUrl, accessToken as string, chunk, `bytes ${offset}-${end - 1}/${file.size}`, loaded => onProgress?.(Math.round((offset + loaded) / file.size * 100)));
                if (response.videoId) { result = response.videoId; break; }
                offset = response.confirmedBytes || end;
                onProgress?.(Math.round(offset / file.size * 100));
            }
        } catch (error) {
            if (attempt === 4) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        }
    }
    if (!result) throw new Error('YouTube did not confirm the Short upload. Retry to resume it.');
    sessionStorage.removeItem(stateKey);
    onProgress?.(100);
    return result;
}

// tracked-content screenshots use the same multipart storage path
async function uploadImage(file: File, config: MediaStorageConfig): Promise<string> {
    return uploadMedia(file, config);
}

export interface ManagedVideo { id: string; title: string; description: string; privacyStatus: string }
export const api = {
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

    addInstagramAccount: (accessToken: string) => request<AccountResponse>('/accounts/instagram', { method: 'POST', body: JSON.stringify({ accessToken }) }),
    refreshIGToken: (id: string) => request<InstagramTokenRefreshResponse>(`/accounts/${id}/refresh-ig-token`, { method: 'POST' }),
    getIGAnalytics: (id: string) => request<InstagramAnalyticsResponse>(`/accounts/${id}/ig-analytics`),
    getIGMedia: (id: string) => request<InstagramMediaResponse>(`/accounts/${id}/ig-media`),

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
    publishIGContainer: (id: string, containerId: string, mediaUrls: string[] = []) => request<InstagramMediaPublishResponse>(`/accounts/${id}/ig-media-publish`, { method: 'POST', body: JSON.stringify({ containerId, mediaUrls }) }),

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
