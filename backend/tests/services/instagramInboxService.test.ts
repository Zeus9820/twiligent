import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createInstagramInboxService } from '../../services/instagramInboxService.ts';
import { createLogger } from '../../lib/logger.ts';
import type { AccountRepository } from '../../repositories/accountRepository.ts';
import type { InstagramInboxRepository } from '../../repositories/instagramInboxRepository.ts';
import type { InboxComment } from '../../../shared/types/instagramComments.ts';

function fixture() {
    const states = new Map<string, unknown>();
    const saved: Array<{ comment: InboxComment; ownReply: string }> = [];
    let held = false;
    const accounts = { findForUser: async (_id: string, user: string) => user === 'owner' ? { id: 'account', platform: 'instagram', igUserId: '1784', username: 'creator', accessToken: 'IG-test' } : null } as unknown as AccountRepository;
    const inbox = {
        lock: async () => { if (held) return null; held = true; return async () => { held = false; }; },
        syncState: async (_u: string, _a: string, scope = 'history') => structuredClone(states.get(scope) ?? null),
        saveSync: async (_u: string, _a: string, state: unknown, scope = 'history') => { states.set(scope, structuredClone(state)); },
        saveBatch: async (_u: string, _a: string, records: typeof saved) => { saved.push(...records); },
        save: async (_u: string, _a: string, comment: InboxComment, ownReply: string) => { saved.push({ comment, ownReply }); },
    } as unknown as InstagramInboxRepository;
    return { saved, states, service: createInstagramInboxService({ accounts, inbox, context: { requestId: 'test', signal: new AbortController().signal, log: createLogger() } }) };
}

test('sync requests two comment pages at most, detects creator replies and skips creator comments', async t => {
    const f = fixture(); const urls: URL[] = [];
    const fetch = mock.method(globalThis, 'fetch', async (input: string | URL) => {
        const url = new URL(String(input)); urls.push(url);
        if (url.pathname.endsWith('/media')) return Response.json({ data: [1, 2, 3].map(i => ({ id: String(i), comments_count: 1 })) });
        return Response.json({ data: [{ id: `${url.pathname}-viewer`, username: 'viewer', text: 'Nice!', replies: { data: [{ id: 'r', from: { id: '1784' }, text: 'Thank you!' }] } }, { id: 'own', username: 'creator', text: 'My own comment' }] });
    });
    t.after(() => fetch.mock.restore());
    const first = await f.service.sync('owner', 'account');
    assert.equal(urls.length, 3); assert.equal(first.imported, 2); assert.equal(first.hasMore, true);
    assert.ok(urls.filter(url => url.pathname.endsWith('/comments')).every(url => url.searchParams.get('limit') === '25'));
    assert.equal(f.saved.length, 2); assert.ok(f.saved.every(row => row.ownReply === 'Thank you!'));
    await f.service.sync('owner', 'account', 'history');
    assert.equal(urls.length, 4); assert.equal(f.saved.length, 3);
});

test('large threads retain their reply cursor and resolve on a later bounded sync', async t => {
    const f = fixture(); let replyRequests = 0;
    const fetch = mock.method(globalThis, 'fetch', async (input: string | URL) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/media')) return Response.json({ data: [{ id: '1', comments_count: 1 }] });
        if (url.pathname.endsWith('/replies')) { replyRequests++; assert.equal(url.searchParams.get('after'), 'older'); return Response.json({ data: [{ id: 'r', from: { id: '1784' }, text: 'Already answered' }] }); }
        return Response.json({ data: [{ id: '10', username: 'viewer', text: 'Question', replies: { data: [], paging: { next: 'https://example.test', cursors: { after: 'older' } } } }] });
    });
    t.after(() => fetch.mock.restore());
    const first = await f.service.sync('owner', 'account');
    assert.equal(first.hasMore, true); assert.equal(f.saved.length, 0);
    const second = await f.service.sync('owner', 'account', 'history');
    assert.equal(replyRequests, 1); assert.equal(second.hasMore, false); assert.equal(f.saved[0].ownReply, 'Already answered');
});

test('unauthorized accounts never issue Meta requests or access inbox state', async t => {
    const f = fixture();
    const fetch = mock.method(globalThis, 'fetch', async () => { throw new Error('must not call Meta'); });
    t.after(() => fetch.mock.restore());
    await assert.rejects(f.service.sync('other-user', 'account'), /not found/);
    assert.equal(fetch.mock.callCount(), 0); assert.equal(f.states.size, 0);
});
