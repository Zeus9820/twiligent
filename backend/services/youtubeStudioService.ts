import { createOAuthState, verifyOAuthState } from '../lib/oauthState.ts';
import { NotConfiguredError, NotFoundError, UpstreamError, ValidationError } from '../lib/errors.ts';
import type { AccountRepository } from '../repositories/accountRepository.ts';
import type { AppConfig } from '../lib/config.ts';
import type { RequestContext } from '../types/context.ts';
import type { YouTubeStudioSummary } from '../../shared/types/youtube.ts';

const SCOPES = ['https://www.googleapis.com/auth/youtube.force-ssl', 'https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/yt-analytics.readonly', 'https://www.googleapis.com/auth/youtube.upload'];
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REPORT_URL = 'https://youtubeanalytics.googleapis.com/v2/reports';

interface GoogleToken { access_token?: string; refresh_token?: string; scope?: string }
interface Report { rows?: Array<Array<string | number>> }

function bytesToBase64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }
function base64ToBytes(value: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }

async function encryptionKey(secret: string): Promise<CryptoKey> {
    if (!/^[a-fA-F0-9]{64}$/.test(secret)) throw new NotConfiguredError('YouTube token encryption key is invalid.');
    const raw = Uint8Array.from(secret.match(/../g)!, pair => parseInt(pair, 16));
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptYouTubeToken(token: string, key: string, owner: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(owner) }, await encryptionKey(key), new TextEncoder().encode(token));
    return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`;
}

export async function decryptYouTubeToken(value: string, key: string, owner: string): Promise<string> {
    try {
        const [version, iv, ciphertext] = value.split('.');
        if (version !== 'v1' || !iv || !ciphertext) throw new Error('invalid');
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(iv), additionalData: new TextEncoder().encode(owner) }, await encryptionKey(key), base64ToBytes(ciphertext));
        return new TextDecoder().decode(plain);
    } catch { throw new ValidationError('YouTube authorization could not be read. Please reconnect the channel.'); }
}

export function createYouTubeStudioService({ accounts, config, context }: { accounts: AccountRepository; config: AppConfig; context: RequestContext }) {
    const settings = () => {
        if (!config.youtubeStudio) throw new NotConfiguredError('YouTube Analytics connection is not configured yet.');
        return config.youtubeStudio;
    };
    const ownerOf = (userId: string, accountId: string) => `${userId}:${accountId}`;
    async function channel(userId: string, accountId: string) {
        const result = await accounts.findForUser(accountId, userId);
        if (!result || result.platform !== 'youtube' || !result.channelId) throw new NotFoundError('YouTube channel not found.');
        return result;
    }
    async function tokenRequest(params: URLSearchParams): Promise<GoogleToken> {
        const response = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params, signal: context.signal });
        if (!response.ok) throw new UpstreamError('Google could not authorize this YouTube channel. Please reconnect and try again.');
        return await response.json() as GoogleToken;
    }
    async function videoAccess(userId: string, accountId: string) {
        const account = await channel(userId, accountId);
        const s = settings();
        if (!account.encryptedYouTubeRefreshToken) throw new ValidationError('Reconnect YouTube to manage videos.');
        const refresh_token = await decryptYouTubeToken(account.encryptedYouTubeRefreshToken, s.tokenKey, ownerOf(userId, accountId));
        const token = await tokenRequest(new URLSearchParams({ client_id: s.clientId, client_secret: s.clientSecret, refresh_token, grant_type: 'refresh_token' }));
        if (!token.access_token) throw new ValidationError('Reconnect YouTube to manage videos.');
        async function call(path: string, init: RequestInit = {}) {
            const response = await fetch(`https://www.googleapis.com/youtube/v3/${path}`, { ...init, headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' }, signal: context.signal });
            if (!response.ok) throw new UpstreamError('YouTube rejected this action. Reconnect and approve video management access, then try again.');
            return response;
        }
        return { account, call };
    }
    interface Video { id: string; snippet: { channelId: string; title: string; description: string; categoryId: string; tags?: string[]; defaultLanguage?: string; defaultAudioLanguage?: string }; status: { privacyStatus: string; embeddable?: boolean; license?: string; publicStatsViewable?: boolean; selfDeclaredMadeForKids?: boolean; containsSyntheticMedia?: boolean; publishAt?: string } }
    async function ownedVideo(access: Awaited<ReturnType<typeof videoAccess>>, id: string): Promise<Video> {
        if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) throw new ValidationError('Invalid video ID.');
        const data = await (await access.call(`videos?part=snippet,status&id=${id}`)).json() as { items?: Video[] };
        const video = data.items?.[0];
        if (!video || video.snippet.channelId !== access.account.channelId) throw new NotFoundError('Video not found on this channel.');
        return video;
    }
    return {
        async listManagedVideos(userId: string, accountId: string, pageToken = '') {
            const access = await videoAccess(userId, accountId);
            const channels = await (await access.call(`channels?part=contentDetails&id=${access.account.channelId}`)).json() as { items?: Array<{ contentDetails: { relatedPlaylists: { uploads: string } } }> };
            const playlist = channels.items?.[0]?.contentDetails.relatedPlaylists.uploads;
            if (!playlist) throw new NotFoundError('Channel uploads not found.');
            const page = await (await access.call(`playlistItems?part=contentDetails&maxResults=50&playlistId=${encodeURIComponent(playlist)}&pageToken=${encodeURIComponent(pageToken)}`)).json() as { nextPageToken?: string; items?: Array<{ contentDetails: { videoId: string } }> };
            const ids = (page.items ?? []).map(item => item.contentDetails.videoId).join(',');
            const videos = ids ? await (await access.call(`videos?part=snippet,status&id=${ids}`)).json() as { items?: Video[] } : { items: [] };
            return { videos: (videos.items ?? []).map(video => ({ id: video.id, title: video.snippet.title, description: video.snippet.description, privacyStatus: video.status.privacyStatus })), nextPageToken: page.nextPageToken ?? null };
        },
        async editVideo(userId: string, accountId: string, id: string, input: unknown) {
            if (!input || typeof input !== 'object') throw new ValidationError('Invalid video details.');
            const edit = input as { title?: unknown; description?: unknown; privacyStatus?: unknown };
            if (typeof edit.title !== 'string' || !edit.title.trim() || [...edit.title].length > 100 || /[<>]/.test(edit.title) || typeof edit.description !== 'string' || edit.description.length > 5000 || /[<>]/.test(edit.description) || !['public', 'private', 'unlisted'].includes(String(edit.privacyStatus))) throw new ValidationError('Provide a valid title, description and visibility.');
            const access = await videoAccess(userId, accountId);
            const video = await ownedVideo(access, id);
            const { categoryId, tags, defaultLanguage, defaultAudioLanguage } = video.snippet;
            await access.call('videos?part=snippet,status', { method: 'PUT', body: JSON.stringify({ id, snippet: { title: edit.title.trim(), description: edit.description, categoryId, tags, defaultLanguage, defaultAudioLanguage }, status: { privacyStatus: edit.privacyStatus, embeddable: video.status.embeddable, license: video.status.license, publicStatsViewable: video.status.publicStatsViewable, selfDeclaredMadeForKids: video.status.selfDeclaredMadeForKids, containsSyntheticMedia: video.status.containsSyntheticMedia, ...(edit.privacyStatus === 'private' && video.status.publishAt ? { publishAt: video.status.publishAt } : {}) } }) });
        },
        async deleteVideo(userId: string, accountId: string, id: string) {
            const access = await videoAccess(userId, accountId);
            await ownedVideo(access, id);
            await access.call(`videos?id=${id}`, { method: 'DELETE' });
        },
        frontendUrl: config.youtubeStudio?.frontendUrl || config.instagram.frontendUrl,
        async accountIdFromState(state: string): Promise<string | null> {
            const payload = await verifyOAuthState(state, settings().clientSecret);
            const parts = payload?.split('|') ?? [];
            return parts.length === 2 && /^[a-zA-Z0-9-]{1,100}$/.test(parts[1]) ? parts[1] : null;
        },
        async authorizationUrl(userId: string, accountId: string): Promise<string> {
            await channel(userId, accountId);
            const s = settings();
            const state = await createOAuthState(`${userId}|${accountId}`, s.clientSecret);
            const params = new URLSearchParams({ client_id: s.clientId, redirect_uri: s.redirectUri, response_type: 'code',
                scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state });
            return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
        },
        async connect(code: string, state: string): Promise<string> {
            const s = settings();
            const payload = await verifyOAuthState(state, s.clientSecret);
            const parts = payload?.split('|') ?? [];
            if (parts.length !== 2 || !parts[0] || !parts[1]) throw new ValidationError('YouTube connection expired. Please start again.');
            const [userId, accountId] = parts;
            const account = await channel(userId, accountId);
            const token = await tokenRequest(new URLSearchParams({ code, client_id: s.clientId, client_secret: s.clientSecret,
                redirect_uri: s.redirectUri, grant_type: 'authorization_code' }));
            if (!token.access_token || !token.refresh_token) throw new UpstreamError('Google did not return offline access. Please reconnect and approve access.');
            if (token.scope && !SCOPES.every(scope => token.scope!.split(' ').includes(scope))) throw new ValidationError('Approve YouTube Analytics and upload access to connect the channel.');
            const url = new URL('https://www.googleapis.com/youtube/v3/channels');
            url.search = new URLSearchParams({ part: 'id', mine: 'true', maxResults: '50' }).toString();
            const response = await fetch(url, { headers: { Authorization: `Bearer ${token.access_token}` }, signal: context.signal });
            if (!response.ok) throw new UpstreamError('Could not verify which YouTube channel was authorized.');
            const data = await response.json() as { items?: Array<{ id?: string }> };
            if (!data.items?.some(item => item.id === account.channelId)) throw new ValidationError('The Google account you selected does not own this YouTube channel. Choose the channel owner and reconnect.');
            const encrypted = await encryptYouTubeToken(token.refresh_token, s.tokenKey, ownerOf(userId, accountId));
            await accounts.updateForUser(accountId, { encryptedYouTubeRefreshToken: encrypted, youtubeAnalyticsConnected: true, youtubePublishingConnected: true }, userId);
            return accountId;
        },
        async summary(userId: string, accountId: string): Promise<YouTubeStudioSummary> {
            const s = settings();
            const account = await channel(userId, accountId);
            if (!account.encryptedYouTubeRefreshToken) throw new ValidationError('Connect YouTube Analytics first.');
            const refreshToken = await decryptYouTubeToken(account.encryptedYouTubeRefreshToken, s.tokenKey, ownerOf(userId, accountId));
            const token = await tokenRequest(new URLSearchParams({ client_id: s.clientId, client_secret: s.clientSecret,
                refresh_token: refreshToken, grant_type: 'refresh_token' }));
            if (!token.access_token) throw new UpstreamError('Google did not provide a YouTube access token. Please reconnect.');
            const end = new Date(); const start = new Date(end); start.setUTCDate(start.getUTCDate() - 27);
            const endDate = end.toISOString().slice(0, 10); const startDate = start.toISOString().slice(0, 10);
            async function report(params: Record<string, string>): Promise<Report> {
                const url = new URL(REPORT_URL);
                url.search = new URLSearchParams({ ids: `channel==${account.channelId}`, startDate, endDate, ...params }).toString();
                const response = await fetch(url, { headers: { Authorization: `Bearer ${token.access_token}` }, signal: context.signal });
                if (!response.ok) throw new UpstreamError('YouTube Analytics could not load this report. Check that the API is enabled and the channel is authorized.');
                return await response.json() as Report;
            }
            const [totals, videos] = await Promise.all([
                report({ metrics: 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost' }),
                report({ dimensions: 'video', metrics: 'views,estimatedMinutesWatched,averageViewDuration', sort: '-views', maxResults: '10' }),
            ]);
            const values = totals.rows?.[0] ?? [];
            const videoRows = videos.rows ?? [];
            const titles = new Map<string, string>();
            if (videoRows.length) {
                try {
                    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
                    url.search = new URLSearchParams({ part: 'snippet', id: videoRows.map(row => String(row[0])).join(',') }).toString();
                    const response = await fetch(url, { headers: { Authorization: `Bearer ${token.access_token}` }, signal: context.signal });
                    if (response.ok) {
                        const details = await response.json() as { items?: Array<{ id?: string; snippet?: { title?: string } }> };
                        for (const video of details.items ?? []) if (video.id && video.snippet?.title) titles.set(video.id, video.snippet.title);
                    }
                } catch { /* analytics remains useful if titles are unavailable */ }
            }
            return { startDate, endDate, views: Number(values[0] ?? 0), watchMinutes: Number(values[1] ?? 0),
                averageViewDurationSeconds: Number(values[2] ?? 0), subscribersGained: Number(values[3] ?? 0), subscribersLost: Number(values[4] ?? 0),
                topVideos: videoRows.map(row => ({ videoId: String(row[0]), title: titles.get(String(row[0])), views: Number(row[1]), watchMinutes: Number(row[2]), averageViewDurationSeconds: Number(row[3]) })) };
        },
        async startShortUpload(userId: string, accountId: string, input: { title: string; description: string; contentType: string; size: number; privacyStatus: 'private' | 'unlisted' | 'public' }): Promise<{ uploadUrl: string; accessToken: string }> {
            const s = settings();
            const account = await channel(userId, accountId);
            if (!account.encryptedYouTubeRefreshToken || !account.youtubePublishingConnected) throw new ValidationError('Reconnect this YouTube channel and approve the YouTube upload permission before publishing Shorts.');
            if (!input.title.trim() || input.title.trim().length > 100) throw new ValidationError('YouTube Shorts titles must be between 1 and 100 characters.');
            if (input.description.length > 5000) throw new ValidationError('YouTube descriptions must be 5,000 characters or fewer.');
            if (!/^video\/(mp4|quicktime)$/.test(input.contentType) || !Number.isSafeInteger(input.size) || input.size < 1) throw new ValidationError('Choose a valid MP4 or MOV video file.');
            const refreshToken = await decryptYouTubeToken(account.encryptedYouTubeRefreshToken, s.tokenKey, ownerOf(userId, accountId));
            const token = await tokenRequest(new URLSearchParams({ client_id: s.clientId, client_secret: s.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }));
            if (!token.access_token) throw new UpstreamError('Google did not provide a YouTube access token. Reconnect the channel and try again.');
            const url = new URL('https://www.googleapis.com/upload/youtube/v3/videos');
            url.search = new URLSearchParams({ uploadType: 'resumable', part: 'snippet,status' }).toString();
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token.access_token}`,
                    'Content-Type': 'application/json; charset=UTF-8',
                    'X-Upload-Content-Length': String(input.size),
                    'X-Upload-Content-Type': input.contentType,
                },
                body: JSON.stringify({ snippet: { title: input.title.trim(), description: input.description, categoryId: '22' }, status: { privacyStatus: input.privacyStatus } }),
                signal: context.signal,
            });
            const uploadUrl = response.headers.get('location');
            if (!response.ok || !uploadUrl) {
                const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
                throw new UpstreamError(body?.error?.message || 'YouTube could not start the Shorts upload session.');
            }
            if (new URL(uploadUrl).origin !== 'https://www.googleapis.com') throw new UpstreamError('YouTube returned an invalid upload session.');
            return { uploadUrl, accessToken: token.access_token };
        },
    };
}

export type YouTubeStudioService = ReturnType<typeof createYouTubeStudioService>;
