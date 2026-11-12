import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWindsorMedia, publishWindsorPost } from '../../../services/instagram/windsorInstagram.ts';
import { createPublishingService } from '../../../services/publishingService.ts';
import { readConfig } from '../../../lib/config.ts';
import { createLogger } from '../../../lib/logger.ts';
import type { Redis } from '../../../types/app.ts';
import type { AccountRepository } from '../../../repositories/accountRepository.ts';
import type { Env } from '../../../types/env.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('maps Windsor reel metrics to Instagram media', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ result: { structuredContent: { result: {
        status: 'done', data: [{ media_id: 'old', timestamp: '2026-01-01T00:00:00Z' }, { media_id: '1', timestamp: '2026-11-01T00:00:00Z', media_type: 'REELS', media_views: 120, media_like_count: 7, media_comments_count: 2 }],
    } } } }), { headers: { 'Content-Type': 'application/json' } });
    const result = await fetchWindsorMedia('secret', 'account');
    assert.equal(result[0].contentType, 'reel');
    assert.equal(result[1].id, 'old');
    assert.equal(result[0].viewCount, 120);
    assert.equal(result[0].likeCount, 7);
});

test('falls back to 30 days only when the Windsor trial restricts history', async () => {
    const presets: string[] = [];
    globalThis.fetch = async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        presets.push(request.params.arguments.date_preset);
        if (presets.length === 1) return Response.json({ result: { isError: false, structuredContent: { error: 'No data returned: your trial includes the last 30 days of data history, and this request asks for older data.' } } });
        return Response.json({ result: { structuredContent: { result: { status: 'done', data: [{ media_id: '1', media_type: 'REEL' }] } } } });
    };
    const media = await fetchWindsorMedia('secret', 'account');
    assert.deepEqual(presets, ['last_2years', 'last_30d']);
    assert.equal(media[0].contentType, 'reel');
});

test('does not retry unrelated Windsor failures with a shorter date range', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json({ result: { structuredContent: { error: 'Connection revoked' } } }); };
    await assert.rejects(fetchWindsorMedia('secret', 'account'), /Windsor could not complete/);
    assert.equal(calls, 1);
});

test('maps a reel to a single Windsor action without retrying', async () => {
    let count = 0;
    let payload: { params: { arguments: { action: string; params: { video_url: string } } } } | undefined;
    globalThis.fetch = async (_url, init) => {
        count++;
        payload = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ result: { structuredContent: { result: { id: 'published' } } } }), { headers: { 'Content-Type': 'application/json' } });
    };
    await publishWindsorPost('secret', 'account', { mediaType: 'REELS', mediaUrl: 'https://example.com/video.mp4', caption: 'Hello' });
    assert.equal(count, 1);
    assert.equal(payload?.params.arguments.action, 'create_video_post');
    assert.equal(payload?.params.arguments.params.video_url, 'https://example.com/video.mp4');
});

test('rejects unsupported options before invoking Windsor', async () => {
    globalThis.fetch = async () => { throw new Error('unexpected request'); };
    await assert.rejects(publishWindsorPost('secret', 'account', { mediaType: 'IMAGE', mediaUrl: 'https://example.com/a.jpg', locationId: '1' }), /does not support/);
});

test('publishing claims a staged request once and refuses another user', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
        calls++;
        return Response.json({ result: { structuredContent: { result: { id: 'published-id' } } } });
    };
    const entries = new Map<string, unknown>();
    const redis = {
        get: async (key: string) => entries.get(key) ?? null,
        set: async (key: string, value: unknown, options: { nx?: boolean }) => {
            if (options.nx && entries.has(key)) return null;
            entries.set(key, value);
            return 'OK';
        },
    } as unknown as Redis;
    const accounts = {
        findForUser: async (_id: string, userId: string) => userId === 'owner'
            ? { id: 'a', platform: 'instagram', instagramProvider: 'windsor', igUserId: 'ig' }
            : null,
    } as unknown as AccountRepository;
    const config = readConfig({ WINDSOR_API_KEY: 'secret', WINDSOR_OWNER_USER_ID: 'owner' } as Env);
    const service = createPublishingService({ accounts, config, redis, context: { requestId: 'test', log: createLogger(), signal: new AbortController().signal } });
    const id = await service.createContainer('owner', 'a', { mediaType: 'IMAGE', mediaUrl: 'https://example.com/a.jpg' });
    await assert.rejects(service.publishContainer('other', 'a', id));
    assert.equal(await service.publishContainer('owner', 'a', id), 'published-id');
    await assert.rejects(service.publishContainer('owner', 'a', id), /already been sent/);
    assert.equal(calls, 1);
});
