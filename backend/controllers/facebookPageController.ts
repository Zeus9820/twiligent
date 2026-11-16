import { controller, pathParam, servicesFor } from './http.ts';
import { requestLogger } from '../middleware/requestContext.ts';
import { errorFields } from '../lib/logger.ts';

export const getFacebookPageAuthUrl = controller.createHandlers(async c => {
    const url = await servicesFor(c).facebookPage.authorizationUrl(c.get('userId'), pathParam(c, 'id'));
    return c.json({ url });
});

export const handleFacebookPageCallback = controller.createHandlers(async c => {
    const service = servicesFor(c).facebookPage;
    const state = c.req.query('state') || '';
    const code = c.req.query('code');
    const error = c.req.query('error');
    const errorReason = c.req.query('error_reason') || error;
    if (error || !code || !state) return c.redirect(`${service.accountsPageUrl}?fb_error=${encodeURIComponent(errorReason || 'cancelled')}`);
    if (!service.configured) return c.redirect(`${service.accountsPageUrl}?fb_error=not_configured`);
    try {
        await service.connect(state, code);
        return c.redirect(`${service.accountsPageUrl}?fb_connected=true`);
    } catch (err) {
        requestLogger(c).error('Facebook Page connection failed', errorFields(err));
        return c.redirect(`${service.accountsPageUrl}?fb_error=${encodeURIComponent((err as Error).message.slice(0, 140))}`);
    }
});
