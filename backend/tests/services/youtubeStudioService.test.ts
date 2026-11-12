import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createYouTubeStudioService, decryptYouTubeToken, encryptYouTubeToken } from '../../services/youtubeStudioService.ts';
import { readConfig } from '../../lib/config.ts';
import { createLogger } from '../../lib/logger.ts';
import { safeAccount } from '../../lib/safeAccount.ts';
import type { AccountRepository } from '../../repositories/accountRepository.ts';
import type { Account } from '../../../shared/types/domain.ts';
import type { Env } from '../../types/env.ts';

const KEY = '01'.repeat(32);
const config = readConfig({ GOOGLE_YOUTUBE_CLIENT_ID: 'client', GOOGLE_YOUTUBE_CLIENT_SECRET: 'secret', GOOGLE_YOUTUBE_TOKEN_KEY: KEY,
    FRONTEND_URL: 'https://app.example', BACKEND_URL: 'https://api.example' } as Env);
const context = { requestId: 'test', signal: new AbortController().signal, log: createLogger() };

test('refresh tokens are encrypted and bound to their user and channel', async () => {
    const encrypted = await encryptYouTubeToken('my-refresh-token', KEY, 'owner:account');
    assert.ok(!encrypted.includes('my-refresh-token'));
    assert.equal(await decryptYouTubeToken(encrypted, KEY, 'owner:account'), 'my-refresh-token');
    await assert.rejects(decryptYouTubeToken(encrypted, KEY, 'other:account'));
    const safe = safeAccount({ id: 'account', platform: 'youtube', encryptedYouTubeRefreshToken: encrypted });
    assert.equal('encryptedYouTubeRefreshToken' in safe, false);
});

test('OAuth checks the selected channel and stores only an encrypted refresh token', async t => {
    let saved: Partial<Account> = {};
    const accounts = {
        findForUser: async (_id: string, userId: string) => userId === 'user' ? { id: 'account', platform: 'youtube', channelId: 'channel' } : null,
        updateForUser: async (_id: string, value: Partial<Account>) => { saved = value; },
    } as unknown as AccountRepository;
    const fetch = mock.method(globalThis, 'fetch', async (input: string | URL) => {
        if (String(input).includes('/token')) return Response.json({ access_token: 'access', refresh_token: 'refresh' });
        return Response.json({ items: [{ id: 'channel' }] });
    });
    t.after(() => fetch.mock.restore());
    const service = createYouTubeStudioService({ accounts, config, context });
    const url = new URL(await service.authorizationUrl('user', 'account'));
    assert.match(url.searchParams.get('scope') || '', /yt-analytics\.readonly/);
    const state = url.searchParams.get('state')!;
    assert.equal(await service.connect('code', state), 'account');
    assert.equal(saved.youtubeAnalyticsConnected, true);
    assert.equal(await decryptYouTubeToken(saved.encryptedYouTubeRefreshToken!, KEY, 'user:account'), 'refresh');
    assert.equal(JSON.stringify(saved).includes('refresh"'), false);
    assert.equal(await service.accountIdFromState(state + 'tampered'), null);
    await assert.rejects(service.authorizationUrl('other', 'account'));
});

test('OAuth refuses a Google login that does not own the selected channel', async t => {
    let wrote = false;
    const accounts = { findForUser: async () => ({ id: 'account', platform: 'youtube', channelId: 'expected' }),
        updateForUser: async () => { wrote = true; } } as unknown as AccountRepository;
    const fetch = mock.method(globalThis, 'fetch', async (input: string | URL) => String(input).includes('/token')
        ? Response.json({ access_token: 'access', refresh_token: 'refresh' }) : Response.json({ items: [{ id: 'different' }] }));
    t.after(() => fetch.mock.restore());
    const service = createYouTubeStudioService({ accounts, config, context });
    const state = new URL(await service.authorizationUrl('user', 'account')).searchParams.get('state')!;
    await assert.rejects(service.connect('code', state), /does not own/);
    assert.equal(wrote, false);
});

test('loads the channel report with a refreshed token without exposing credentials in URLs', async t => {
    const encrypted = await encryptYouTubeToken('private-refresh', KEY, 'user:account');
    const account = { id: 'account', platform: 'youtube', channelId: 'channel', encryptedYouTubeRefreshToken: encrypted };
    const accounts = { findForUser: async () => account } as unknown as AccountRepository;
    const requested: string[] = [];
    const fetch = mock.method(globalThis, 'fetch', async (input: string | URL) => {
        const url = String(input); requested.push(url);
        if (url.includes('/token')) return Response.json({ access_token: 'private-access' });
        const parsed = new URL(url);
        if (parsed.searchParams.has('dimensions')) return Response.json({ rows: [['video-1', 100, 300, 180]] });
        return Response.json({ rows: [[120, 360, 180, 4, 1]] });
    });
    t.after(() => fetch.mock.restore());
    const summary = await createYouTubeStudioService({ accounts, config, context }).summary('user', 'account');
    assert.equal(summary.views, 120);
    assert.equal(summary.watchMinutes, 360);
    assert.equal(summary.subscribersGained, 4);
    assert.equal(summary.topVideos[0].videoId, 'video-1');
    assert.ok(requested.every(url => !url.includes('private-access') && !url.includes('private-refresh')));
    assert.equal(requested.filter(url => url.includes('/v2/reports')).length, 2);
});
