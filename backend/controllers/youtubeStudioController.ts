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
    return c.json({ success: true, ...upload });
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
