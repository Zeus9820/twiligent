import { Hono } from 'hono';
import { listInstagramInbox, syncInstagramInbox, readInstagramInboxComment, listInstagramComments, replyToInstagramComment, suggestInstagramCommentReply } from '../controllers/instagramCommentController.ts';
import type { AppEnv } from '../types/app.ts';
import { rateLimit, userKey } from '../middleware/rateLimit.ts';

const router = new Hono<AppEnv>();
router.get('/accounts/:id/ig-inbox', ...listInstagramInbox);
router.post('/accounts/:id/ig-inbox/sync', rateLimit({ name: 'ig-inbox-sync', label: 'Please wait before syncing again', config: { algorithm: 'fixedWindow', limit: 30, windowMs: 60000 } }, userKey), ...syncInstagramInbox);
router.post('/accounts/:id/ig-inbox/:commentId/read', ...readInstagramInboxComment);
router.get('/accounts/:id/ig-comments', ...listInstagramComments);
router.post('/accounts/:id/ig-comments/suggest-reply', rateLimit({ name: 'ig-comment-reply-suggestion', label: 'Daily reply suggestion limit reached', config: { algorithm: 'fixedWindow', limit: 30, windowMs: 86400000 } }, userKey), ...suggestInstagramCommentReply);
router.post('/accounts/:id/ig-comments/reply', ...replyToInstagramComment);
export default router;
