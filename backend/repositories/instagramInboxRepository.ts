import { NotConfiguredError } from '../lib/errors.ts';
import type { Redis } from '../types/app.ts';
import type { InboxComment, InboxFilter, InboxPage } from '../../shared/types/instagramComments.ts';

const CACHE_TTL = 7 * 86400;
export function createInstagramInboxRepository(redis: Redis | null) {
    function client(): Redis { if (!redis) throw new NotConfiguredError('Comment inbox storage is unavailable. Please try again later.'); return redis; }
    const prefix = (user: string, account: string) => `ig-inbox:v1:${user}:${account}`;
    const update = `
local state = cjson.decode(redis.call('HGET', KEYS[1], ARGV[1]) or '{}')
if ARGV[3] == 'read' then state.readAt = ARGV[4] end
if ARGV[3] == 'replied' then state.repliedAt = ARGV[4]; state.replyText = ARGV[5] end
if ARGV[3] == 'ingest' and ARGV[5] ~= '' then state.repliedAt = state.repliedAt or ARGV[4]; state.replyText = ARGV[5] end
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(state))
local member = ARGV[2]
redis.call('ZADD', KEYS[2], 0, member)
redis.call('ZREM', KEYS[3], member); redis.call('ZREM', KEYS[4], member); redis.call('ZREM', KEYS[5], member)
if state.repliedAt then redis.call('ZADD', KEYS[5], 0, member)
else redis.call('ZADD', KEYS[3], 0, member); if not state.readAt then redis.call('ZADD', KEYS[4], 0, member) end end
for i=2,5 do redis.call('EXPIRE', KEYS[i], ARGV[6]) end
return 1`;
    const member = (comment: InboxComment) => `${String(new Date(comment.timestamp).getTime() || 0).padStart(16, '0')}:${comment.id}`;
    async function change(user: string, account: string, comment: InboxComment, action: string, replyText = '') {
        const p = prefix(user, account);
        await client().eval(update, [`${p}:status`, `${p}:all`, `${p}:needs_reply`, `${p}:unread`, `${p}:replied`], [comment.id, member(comment), action, new Date().toISOString(), replyText, CACHE_TTL]);
    }
    return {
        async save(user: string, account: string, comment: InboxComment, ownReply = '') {
            await client().set(`${prefix(user, account)}:comment:${comment.id}`, comment, { ex: CACHE_TTL });
            await change(user, account, comment, 'ingest', ownReply);
        },
        async saveBatch(user: string, account: string, records: Array<{ comment: InboxComment; ownReply: string }>) {
            if (!records.length) return;
            const p = prefix(user, account);
            const pipeline = client().pipeline();
            for (const { comment, ownReply } of records) {
                pipeline.set(`${p}:comment:${comment.id}`, comment, { ex: CACHE_TTL });
                pipeline.eval(update, [`${p}:status`, `${p}:all`, `${p}:needs_reply`, `${p}:unread`, `${p}:replied`], [comment.id, member(comment), 'ingest', new Date().toISOString(), ownReply, CACHE_TTL]);
            }
            await pipeline.exec();
        },
        async get(user: string, account: string, id: string) { return client().get<InboxComment>(`${prefix(user, account)}:comment:${id}`); },
        async status(user: string, account: string, id: string) { return (await client().hget<{ readAt?: string; repliedAt?: string; replyText?: string }>(`${prefix(user, account)}:status`, id)) ?? {}; },
        async markRead(user: string, account: string, comment: InboxComment) { await change(user, account, comment, 'read'); },
        async markReplied(user: string, account: string, comment: InboxComment, text: string) { await change(user, account, comment, 'replied', text); },
        async page(user: string, account: string, filter: InboxFilter, cursor?: string): Promise<InboxPage> {
            const p = prefix(user, account);
            const members = await client().zrange<string[]>(`${p}:${filter}`, cursor ? `(${cursor}` : '+', '-', { byLex: true, rev: true, offset: 0, count: 26 });
            const consumed = members.slice(0, 25);
            const comments: InboxComment[] = [];
            if (!consumed.length) return { comments, nextCursor: null };
            const pipeline = client().pipeline();
            for (const entry of consumed) {
                const id = entry.split(':')[1];
                pipeline.get(`${p}:comment:${id}`);
                pipeline.hget(`${p}:status`, id);
            }
            const fetched = await pipeline.exec<Array<InboxComment | { readAt?: string; repliedAt?: string; replyText?: string } | null>>();
            for (const [index, entry] of consumed.entries()) {
                const id = entry.split(':')[1];
                const comment = fetched[index * 2] as InboxComment | null;
                if (!comment) { await Promise.all(['all', 'needs_reply', 'unread', 'replied'].map(name => client().zrem(`${p}:${name}`, entry))); continue; }
                const state = (fetched[index * 2 + 1] ?? {}) as { readAt?: string; repliedAt?: string; replyText?: string };
                // Recheck state after reading the index: a reply/read may race a page request.
                if (filter === 'needs_reply' && state.repliedAt || filter === 'unread' && (state.readAt || state.repliedAt) || filter === 'replied' && !state.repliedAt) continue;
                comments.push({ ...comment, ...state });
            }
            return { comments, nextCursor: members.length > 25 ? consumed.at(-1)! : null };
        },
        async syncState<T>(user: string, account: string, scope = 'history') { return client().get<T>(`${prefix(user, account)}:sync:${scope}`); },
        async saveSync(user: string, account: string, state: unknown, scope = 'history') { await client().set(`${prefix(user, account)}:sync:${scope}`, state, { ex: CACHE_TTL }); },
        async lock(user: string, account: string, scope = 'sync') {
            const token = crypto.randomUUID();
            const key = `${prefix(user, account)}:lock:${scope}`;
            if (!await client().set(key, token, { nx: true, ex: 90 })) return null;
            return async () => { await client().eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end", [key], [token]); };
        },
    };
}
export type InstagramInboxRepository = ReturnType<typeof createInstagramInboxRepository>;
