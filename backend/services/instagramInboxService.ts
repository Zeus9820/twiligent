import { NotFoundError, ValidationError } from '../lib/errors.ts';
import { igFetch } from './instagram/instagramApi.ts';
import type { AccountRepository } from '../repositories/accountRepository.ts';
import type { InstagramInboxRepository } from '../repositories/instagramInboxRepository.ts';
import type { RequestContext } from '../types/context.ts';
import type { InboxComment, InboxFilter, InboxSyncResult } from '../../shared/types/instagramComments.ts';

interface Post { id: string; caption?: string; permalink?: string; comments_count?: number }
interface Edge<T> { data?: T[]; paging?: { next?: string; cursors?: { after?: string } } }
interface Comment { id: string; text?: string; username?: string; from?: { id?: string; username?: string }; timestamp?: string; like_count?: number; hidden?: boolean; replies?: Edge<Comment> }
interface SyncState { posts: Post[]; postIndex: number; mediaAfter?: string; commentAfter?: string; done: boolean; syncedAt: string; pending?: Array<{ comment: InboxComment; after: string }> }
const next = (edge: Edge<unknown>) => edge.paging?.next ? edge.paging.cursors?.after : undefined;

export function createInstagramInboxService({ accounts, inbox, context }: { accounts: AccountRepository; inbox: InstagramInboxRepository; context: RequestContext }) {
    async function accountFor(user: string, id: string) {
        const account = await accounts.findForUser(id, user);
        if (!account || account.platform !== 'instagram') throw new NotFoundError('Instagram account not found.');
        if (!account.accessToken || !account.igUserId || account.instagramProvider === 'windsor') throw new ValidationError('Connect Instagram directly with Meta to use the inbox.');
        return account;
    }
    return {
        async page(user: string, id: string, filter: InboxFilter, cursor?: string) {
            await accountFor(user, id);
            return inbox.page(user, id, filter, cursor);
        },
        async read(user: string, id: string, commentId: string) {
            await accountFor(user, id);
            const comment = await inbox.get(user, id, commentId);
            if (!comment) throw new NotFoundError('This cached comment expired. Sync the inbox to reload it.');
            await inbox.markRead(user, id, comment);
        },
        async sync(user: string, id: string, mode: 'latest' | 'history' = 'latest'): Promise<InboxSyncResult> {
            const account = await accountFor(user, id);
            const release = await inbox.lock(user, id);
            if (!release) return { imported: 0, hasMore: true, syncedAt: '', busy: true };
            try {
                const history = await inbox.syncState<SyncState>(user, id);
                let state = mode === 'history' ? history : await inbox.syncState<SyncState>(user, id, 'latest');
                if (state && (mode === 'latest' || state.done) && Date.now() - Date.parse(state.syncedAt) < 60_000) return { imported: 0, hasMore: history ? !history.done : !state.done, syncedAt: state.syncedAt };
                if (mode === 'latest' || !state || state.done) state = { posts: [], postIndex: 0, done: false, syncedAt: '', pending: state?.pending ?? [] };
                let imported = 0;
                state.pending ??= [];
                const isOwner = (comment: Comment) => comment.from?.id === account.igUserId || !!account.username && (comment.username || comment.from?.username || '').toLowerCase() === account.username.toLowerCase();
                let budget = 2;
                while (state.pending.length && budget > 0) {
                    const pending = state.pending[0];
                    const replies = await igFetch<Edge<Comment>>(`/${pending.comment.id}/replies`, { access_token: account.accessToken!, fields: 'id,text,from,username,timestamp', limit: '100', after: pending.after }, 0, context.signal);
                    budget--;
                    const own = replies.data?.find(isOwner);
                    const after = next(replies);
                    if (own || !after) {
                        await inbox.save(user, id, pending.comment, own ? own.text || '(Replied on Instagram)' : '');
                        state.pending.shift(); imported++;
                    } else pending.after = after;
                }
                // At most one media discovery page and two comment pages per request.
                if (budget > 0 && state.postIndex >= state.posts.length && (state.mediaAfter || (!state.posts.length && !state.syncedAt))) {
                    const edge = await igFetch<Edge<Post>>(`/${account.igUserId}/media`, { access_token: account.accessToken!, fields: 'id,caption,permalink,comments_count', limit: '10', ...(state.mediaAfter ? { after: state.mediaAfter } : {}) }, 0, context.signal);
                    state.posts = (edge.data ?? []).filter(post => (post.comments_count ?? 0) > 0);
                    state.postIndex = 0;
                    state.mediaAfter = next(edge);
                    state.commentAfter = undefined;
                }
                for (let batch = 0; batch < budget && state.postIndex < state.posts.length; batch++) {
                    const post = state.posts[state.postIndex];
                    const edge = await igFetch<Edge<Comment>>(`/${post.id}/comments`, { access_token: account.accessToken!, fields: 'id,text,username,from,timestamp,like_count,hidden,replies.limit(100){id,text,from,username,timestamp}', limit: '25', ...(state.commentAfter ? { after: state.commentAfter } : {}) }, 0, context.signal);
                    const records: Array<{ comment: InboxComment; ownReply: string }> = [];
                    for (const comment of edge.data ?? []) {
                        if (isOwner(comment)) continue;
                        const ownerReply = comment.replies?.data?.find(isOwner);
                        const record: InboxComment = { id: comment.id, mediaId: post.id, text: comment.text ?? '', username: comment.username || comment.from?.username || 'Instagram user', timestamp: comment.timestamp || new Date().toISOString(), likeCount: comment.like_count ?? 0, hidden: !!comment.hidden, caption: post.caption ?? '', permalink: post.permalink ?? '' };
                        const replyCursor = next(comment.replies ?? {});
                        if (!ownerReply && replyCursor) {
                            if (!state.pending.some(item => item.comment.id === comment.id)) state.pending.push({ comment: record, after: replyCursor });
                            continue;
                        }
                        records.push({ comment: record, ownReply: ownerReply ? ownerReply.text || '(Replied on Instagram)' : '' });
                        imported++;
                    }
                    await inbox.saveBatch(user, id, records);
                    state.commentAfter = next(edge);
                    if (!state.commentAfter) state.postIndex++;
                }
                state.done = state.postIndex >= state.posts.length && !state.mediaAfter && !state.pending.length;
                state.syncedAt = new Date().toISOString();
                await inbox.saveSync(user, id, state, mode);
                if (mode === 'latest' && !history) await inbox.saveSync(user, id, state);
                return { imported, hasMore: mode === 'history' || !history ? !state.done : !history.done, syncedAt: state.syncedAt };
            } finally { await release(); }
        },
    };
}
export type InstagramInboxService = ReturnType<typeof createInstagramInboxService>;
