import { ValidationError } from '../lib/errors.ts';
import { controller, pathParam, servicesFor } from './http.ts';
import { jsonBody, queryParams } from '../middleware/validate.ts';
import { parseContainerInput, parseContainerStatusQuery, parseFacebookPageRetryInput, parsePublishRequest } from '../validators/publishingValidators.ts';
import { deletePublishedMedia, ownedMediaObjectKey } from '../lib/mediaStorage.ts';
import { requestLogger } from '../middleware/requestContext.ts';
import { errorFields } from '../lib/logger.ts';
import type {
    InstagramContainerStatusResponse, InstagramMediaPublishResponse, InstagramPublishingLimitResponse, InstagramPublishResponse,
} from '../../shared/types/instagram.ts';

export const getPublishingLimit = controller.createHandlers(async c => {
    const data = await servicesFor(c).publishing.publishingLimit(c.get('userId'), pathParam(c, 'id'));
    return c.json({ success: true, data } satisfies InstagramPublishingLimitResponse);
});

export const createContainer = controller.createHandlers(jsonBody(parsePublishRequest), async c => {
    const containerId = await servicesFor(c).publishing.createContainer(c.get('userId'), pathParam(c, 'id'), c.req.valid('json'));
    return c.json({ success: true, containerId } satisfies InstagramPublishResponse);
});

export const getContainerStatus = controller.createHandlers(queryParams(parseContainerStatusQuery), async c => {
    const { accountId } = c.req.valid('query');
    const { statusCode, status } = await servicesFor(c).publishing.containerStatus(c.get('userId'), accountId, pathParam(c, 'containerId'));
    return c.json({ success: true, statusCode, status } satisfies InstagramContainerStatusResponse);
});

export const publishContainer = controller.createHandlers(jsonBody(parseContainerInput), async c => {
    const { containerId, mediaUrls, mediaUrl, caption, mediaType } = c.req.valid('json');
    const userId = c.get('userId');
    const result = await servicesFor(c).publishing.publishContainer(userId, pathParam(c, 'id'), containerId, { mediaUrl, caption, mediaType });
    {
        for (const uploadedUrl of mediaUrls) {
            // Keep only the source Reel when Facebook needs a retry; a separate cover image is no longer needed.
            if (result.facebookError && uploadedUrl === mediaUrl) continue;
            try {
                await deletePublishedMedia(c.env.MEDIA_BUCKET, c.env.MEDIA_PUBLIC_URL, uploadedUrl, `${userId}/`);
            } catch (err) {
                requestLogger(c).warn('published media cleanup failed', { ...errorFields(err) });
            }
        }
    }
    return c.json({ success: true, mediaId: result.mediaId, ...(result.facebookMediaId ? { facebookMediaId: result.facebookMediaId } : {}), ...(result.facebookError ? { facebookError: result.facebookError } : {}) } satisfies InstagramMediaPublishResponse);
});

export const instagramMediaCapabilities = controller.createHandlers(async c => c.json(await servicesFor(c).publishing.mediaCapabilities(c.get('userId'), pathParam(c, 'id'))));
export const retryFacebookPagePublish = controller.createHandlers(jsonBody(parseFacebookPageRetryInput), async c => {
    const { mediaUrl, caption } = c.req.valid('json');
    const userId = c.get('userId');
    if (!ownedMediaObjectKey(c.env.MEDIA_PUBLIC_URL, mediaUrl, `${userId}/`)) throw new ValidationError('The retry video must be an uploaded file owned by this account. Upload it again before retrying.');
    const videoId = await servicesFor(c).publishing.publishFacebookOnly(userId, pathParam(c, 'id'), mediaUrl, caption);
    try {
        await deletePublishedMedia(c.env.MEDIA_BUCKET, c.env.MEDIA_PUBLIC_URL, mediaUrl, `${userId}/`);
    } catch (err) {
        requestLogger(c).warn('Facebook published media cleanup failed', { ...errorFields(err) });
    }
    return c.json({ success: true, videoId });
});
export const manageInstagramComments = controller.createHandlers(async c => {
    const body = await c.req.json() as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') throw new ValidationError('Specify whether comments are enabled.');
    await servicesFor(c).publishing.manageMedia(c.get('userId'), pathParam(c, 'id'), pathParam(c, 'mediaId'), 'comments', body.enabled);
    return c.json({ success: true });
});
export const deleteInstagramMedia = controller.createHandlers(async c => {
    await servicesFor(c).publishing.manageMedia(c.get('userId'), pathParam(c, 'id'), pathParam(c, 'mediaId'), 'delete');
    return c.json({ success: true });
});
