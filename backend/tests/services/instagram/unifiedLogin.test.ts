import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthorizationUrl } from '../../../services/instagram/instagramOAuth.ts';
import { fetchInstagramProfile } from '../../../services/instagram/instagramApi.ts';
import { installFetch, reply } from '../../fixtures/fakeFetch.ts';

test('Unified Login uses the Meta configuration without legacy Instagram scopes', async () => {
    const url = new URL(await buildAuthorizationUrl({ appId: 'app', appSecret: 'secret', configId: 'configuration', redirectUri: 'https://example.com/callback', frontendUrl: 'https://example.com' }, 'user'));
    assert.equal(url.origin, 'https://www.facebook.com');
    assert.equal(url.searchParams.get('config_id'), 'configuration');
    assert.equal(url.searchParams.has('scope'), false);
});

test('Unified Login discovers the shared account before reading its profile', async () => {
    const mock = installFetch((_request, count) => reply(count === 1 ? { data: [{ id: '123', username: 'example' }] } : { id: '123', username: 'example' }));
    try {
        const profile = await fetchInstagramProfile(null, 'EA_TEST');
        assert.equal(profile.igUserId, '123');
        assert.equal(mock.requests.length, 2);
    } finally { mock.restore(); }
});

test('Unified Login rejects empty asset assignments', async () => {
    const mock = installFetch(() => reply({ data: [] }));
    try {
        await assert.rejects(fetchInstagramProfile(null, 'EA_TEST'), /no Instagram accounts/);
        assert.equal(mock.requests.length, 1);
    } finally { mock.restore(); }
});
