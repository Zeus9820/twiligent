import { controller, pathParam, servicesFor } from './http.ts';
import { ValidationError } from '../lib/errors.ts';
import type { InstagramCommentsPage } from '../../shared/types/instagramComments.ts';

export const listInstagramComments = controller.createHandlers(async c => {
    const mediaId = c.req.query('mediaId') || '';
    if (!mediaId) throw new ValidationError('Select an Instagram post to load its comments.');
    const result = await servicesFor(c).instagramComments.list(c.get('userId'), pathParam(c, 'id'), mediaId, c.req.query('after'));
    return c.json({ success: true, ...result } satisfies { success: true } & InstagramCommentsPage);
});

export const suggestInstagramCommentReply = controller.createHandlers(async c => {
    const body = await c.req.json().catch(() => ({})) as { mediaId?: unknown; commentId?: unknown };
    if (typeof body.mediaId !== 'string' || typeof body.commentId !== 'string') throw new ValidationError('Select a comment to draft its reply.');
    const suggestion = await servicesFor(c).instagramComments.suggestReply(c.get('userId'), pathParam(c, 'id'), body.mediaId, body.commentId);
    return c.json({ success: true, suggestion });
});

export const replyToInstagramComment = controller.createHandlers(async c => {
    const body = await c.req.json().catch(() => ({})) as { mediaId?: unknown; commentId?: unknown; text?: unknown };
    if (typeof body.mediaId !== 'string' || typeof body.commentId !== 'string' || typeof body.text !== 'string') {
        throw new ValidationError('A post, comment and reply text are required.');
    }
    const comment = await servicesFor(c).instagramComments.reply(c.get('userId'), pathParam(c, 'id'), body.mediaId, body.commentId, body.text);
    return c.json({ success: true, comment });
});

export const listInstagramInbox = controller.createHandlers(async c => {
    const filter = c.req.query('filter') || 'needs_reply';
    if (!['needs_reply', 'unread', 'replied', 'all'].includes(filter)) throw new ValidationError('Invalid inbox filter.');
    const cursor = c.req.query('cursor');
    if (cursor && !/^\d{16}:\d{1,40}$/.test(cursor)) throw new ValidationError('Invalid inbox cursor.');
    const result = await servicesFor(c).instagramInbox.page(c.get('userId'), pathParam(c, 'id'), filter as import('../../shared/types/instagramComments.ts').InboxFilter, cursor);
    return c.json({ success: true, ...result });
});
export const syncInstagramInbox = controller.createHandlers(async c => c.json({ success: true, ...await servicesFor(c).instagramInbox.sync(c.get('userId'), pathParam(c, 'id'), c.req.query('mode') === 'history' ? 'history' : 'latest') }));
export const readInstagramInboxComment = controller.createHandlers(async c => {
    await servicesFor(c).instagramInbox.read(c.get('userId'), pathParam(c, 'id'), pathParam(c, 'commentId'));
    return c.json({ success: true });
});
