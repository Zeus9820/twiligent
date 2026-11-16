import { controller, pathParam, servicesFor } from './http.ts';
import { jsonBody } from '../middleware/validate.ts';
import { parseYouTubeShortUploadInput } from '../validators/publishingValidators.ts';

export const getYouTubeStudioUrl = controller.createHandlers(async c => {
    const url = await servicesFor(c).youtubeStudio.authorizationUrl(c.get('userId'), pathParam(c, 'id'));
    return c.json({ url });
});

export const getYouTubeStudioSummary = controller.createHandlers(async c => {
    const data = await servicesFor(c).youtubeStudio.summary(c.get('userId'), pathParam(c, 'id'));
    return c.json({ success: true, data });
});

export const startYouTubeShortUpload = controller.createHandlers(jsonBody(parseYouTubeShortUploadInput), async c => {
    const upload = await servicesFor(c).youtubeStudio.startShortUpload(c.get('userId'), pathParam(c, 'id'), c.req.valid('json'));
    const redis = c.get('redis');
    if (!redis) return c.json({ success: false, error: 'Upload sessions are unavailable.' }, 503);
    const sessionId = crypto.randomUUID();
    await redis.set(`youtube:upload:${c.get('userId')}:${sessionId}`, upload, { ex: 3600 });
    return c.json({ success: true, sessionId, ...upload });
});

export const uploadYouTubeShortChunk = controller.createHandlers(async c => {
    const sessionId = pathParam(c, 'sessionId');
    if (!/^[\da-f-]{36}$/i.test(sessionId)) return c.json({ error: 'Invalid upload session.' }, 400);
    const redis = c.get('redis');
    if (!redis) return c.json({ error: 'Upload sessions are unavailable.' }, 503);
    const sessionKey = `youtube:upload:${c.get('userId')}:${sessionId}`;
    const saved = await redis.get<{ uploadUrl: string; accessToken: string; videoId?: string }>(sessionKey);
    if (!saved) return c.json({ error: 'Upload session expired. Start a new upload.' }, 404);
    if (saved.videoId) return c.json({ status: 200, videoId: saved.videoId });
    const url = new URL(saved.uploadUrl);
    if (url.origin !== 'https://www.googleapis.com' || url.pathname !== '/upload/youtube/v3/videos') return c.json({ error: 'Invalid upload session.' }, 400);
    const range = c.req.header('Content-Range') || '';
    if (!/^bytes (?:\d+-\d+|\*)\/\d+$/.test(range)) return c.json({ error: 'Invalid upload range.' }, 400);
    const declared = Number(c.req.header('Content-Length'));
    if (declared > 8 * 1024 * 1024) return c.json({ error: 'Upload chunk is too large.' }, 413);
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength > 8 * 1024 * 1024) return c.json({ error: 'Upload chunk is too large.' }, 413);
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
    if ((match && (Number(match[2]) < Number(match[1]) || Number(match[2]) >= Number(match[3]) || Number(match[2]) - Number(match[1]) + 1 !== bytes.byteLength)) || (!match && bytes.byteLength)) return c.json({ error: 'Upload chunk does not match its range.' }, 400);
    const response = await fetch(url, { method: 'PUT', redirect: 'manual', headers: { Authorization: `Bearer ${saved.accessToken}`, 'Content-Range': range, 'Content-Type': 'application/octet-stream' }, body: bytes.byteLength ? bytes : null, signal: c.get('signal') });
    if (response.status === 308) return c.json({ status: 308, range: response.headers.get('Range') });
    const body = await response.json().catch(() => ({})) as { id?: string; error?: { message?: string } };
    if (!response.ok || !body.id) return c.json({ error: body.error?.message || `YouTube upload failed (HTTP ${response.status}).` }, response.status >= 400 && response.status < 600 ? response.status as 400 : 502);
    await redis.set(sessionKey, { ...saved, videoId: body.id }, { ex: 86400 });
    return c.json({ status: response.status, videoId: body.id });
});

export const handleYouTubeStudioCallback = controller.createHandlers(async c => {
    const service = servicesFor(c).youtubeStudio;
    const state = c.req.query('state') || '';
    let accountId: string | null = null;
    try {
        accountId = await service.accountIdFromState(state);
        const code = c.req.query('code');
        if (!accountId || !code || c.req.query('error')) throw new Error('YouTube authorization was cancelled or expired.');
        const connectedId = await service.connect(code, state);
        return c.redirect(`${service.frontendUrl}/channel/${encodeURIComponent(connectedId)}?youtube_studio=connected`);
    } catch (error) {
        const message = encodeURIComponent((error as Error).message.slice(0, 180));
        const target = accountId ? `/channel/${encodeURIComponent(accountId)}` : '/accounts';
        return c.redirect(`${service.frontendUrl}${target}?youtube_studio_error=${message}`);
    }
});

export const listManagedVideos = controller.createHandlers(async c => c.json(await servicesFor(c).youtubeStudio.listManagedVideos(c.get('userId'), pathParam(c, 'id'), c.req.query('pageToken'))));
export const editManagedVideo = controller.createHandlers(async c => {
    await servicesFor(c).youtubeStudio.editVideo(c.get('userId'), pathParam(c, 'id'), pathParam(c, 'videoId'), await c.req.json());
    return c.json({ success: true });
});
export const deleteManagedVideo = controller.createHandlers(async c => {
    await servicesFor(c).youtubeStudio.deleteVideo(c.get('userId'), pathParam(c, 'id'), pathParam(c, 'videoId'));
    return c.json({ success: true });
});

export const getManagedVideo = controller.createHandlers(async c => c.json(await servicesFor(c).youtubeStudio.getManagedVideo(c.get('userId'), pathParam(c, 'id'), pathParam(c, 'videoId'))));
