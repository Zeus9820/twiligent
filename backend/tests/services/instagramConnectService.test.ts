import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createInstagramConnectService } from '../../services/instagramConnectService.ts';
import { DatabaseError } from '../../lib/errors.ts';
import { readConfig } from '../../lib/config.ts';
import { createLogger } from '../../lib/logger.ts';
import type { AccountRepository } from '../../repositories/accountRepository.ts';
import type { AuditEvent, AuditRepository } from '../../repositories/auditRepository.ts';
import type { Account } from '../../../shared/types/domain.ts';
import type { Env } from '../../types/env.ts';

const ENV = { INSTAGRAM_APP_ID: 'APPID', INSTAGRAM_APP_SECRET: 'APPSECRET' } as Env;

test('a connect that loses a race to a second connect of the same account renews the stored token instead of failing', async t => {
    // the code exchange, the long-lived upgrade and the profile, by url
    const fetch = mock.method(globalThis, 'fetch', async (input: string | URL) => {
        const url = String(input);
        if (url.includes('oauth/access_token')) return Response.json({ access_token: 'SHORT' });
        if (url.includes('/access_token')) return Response.json({ access_token: 'LONG', expires_in: 5184000 });
        return Response.json({ user_id: '1789', username: 'ribbon' });
    });
    t.after(() => fetch.mock.restore());

    // the first lookup sees nothing; by the time the insert fails the other connect has stored the account
    const stored: Account = { id: 'ig-1', platform: 'instagram', igUserId: '1789' } as Account;
    let lookups = 0;
    const updates: Array<[string, Partial<Account>]> = [];
    const accounts = {
        listForUser: async () => (lookups++ === 0 ? [] : [stored]),
        create: async () => { throw new DatabaseError('accounts.create', { code: '23505' }); },
        updateForUser: async (id: string, values: Partial<Account>) => { updates.push([id, values]); },
    } as unknown as AccountRepository;
    const events: AuditEvent[] = [];
    const audit = { recordForUser: async (_userId: string, event: AuditEvent) => { events.push(event); } } as unknown as AuditRepository;

    const connect = createInstagramConnectService({
        accounts,
        audit,
        config: readConfig(ENV),
        context: { requestId: 'req-test', signal: new AbortController().signal, log: createLogger() },
    });

    assert.equal(await connect.connect('user-1', 'CODE'), 'reconnected');
    assert.deepEqual(updates.map(([id, values]) => [id, values.accessToken]), [['ig-1', 'LONG']]);
    assert.deepEqual(events.map(event => event.action), ['account.reconnected']);
});

test('Windsor connection is restricted to the configured owner and stores no Windsor API key', async t => {
    const fetch = mock.method(globalThis, 'fetch', async (_input: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { params: { name: string } };
        const result = body.params.name === 'get_connectors'
            ? [{ id: 'instagram', accounts: [{ id: 'ig-1' }] }]
            : { status: 'done', data: [{ user_name: 'creator', followers_count: 10 }] };
        return Response.json({ result: { structuredContent: { result } } });
    });
    t.after(() => fetch.mock.restore());
    let stored: Account | undefined;
    const accounts = {
        listForUser: async () => [],
        create: async (account: Account) => { stored = account; },
    } as unknown as AccountRepository;
    const audit = { recordForUser: async () => {} } as unknown as AuditRepository;
    const config = readConfig({ ...ENV, WINDSOR_API_KEY: 'secret-key', WINDSOR_OWNER_USER_ID: 'owner' });
    const service = createInstagramConnectService({ accounts, audit, config, context: { requestId: 'test', signal: new AbortController().signal, log: createLogger() } });
    const url = new URL(await service.authorizationUrl('owner'));
    assert.equal(url.hostname, 'www.instagram.com');
    assert.equal(await service.userIdFromState(url.searchParams.get('state') || ''), 'owner');
    await assert.rejects(service.connect('other', 'windsor'), /not configured/);
    assert.equal(await service.connect('owner', 'windsor'), 'connected');
    assert.equal(stored?.igUserId, 'ig-1');
    assert.equal(stored?.instagramProvider, 'windsor');
    assert.equal(stored?.accessToken, '');
    assert.equal(JSON.stringify(stored).includes('secret-key'), false);
});
