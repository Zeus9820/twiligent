import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { allowedClipSource, clippingPublicRoutes } from '../../routes/clippingRoutes.ts';
import type { Redis, AppEnv } from '../../types/app.ts';
import type { Env } from '../../types/env.ts';

test('video source allowlist rejects local addresses, deceptive domains and credential-bearing links', () => {
    for (const value of ['http://youtube.com/watch?v=x', 'https://youtube.com.evil.test/watch?v=x', 'https://127.0.0.1/a', 'file:///etc/passwd', 'https://user:pass@youtube.com/watch?v=x', 'https://youtube.com:8443/a', 'https://evil.test/?url=https://youtube.com', 'not a URL']) assert.equal(allowedClipSource(value), false, value);
    for (const value of ['https://www.youtube.com/watch?v=x', 'https://youtu.be/x', 'https://www.twitch.tv/videos/123', 'https://kick.com/video/x']) assert.equal(allowedClipSource(value), true, value);
});

function fixture(output: unknown) {
    const jid = '00000000-0000-4000-8000-000000000001';
    const lease = '00000000-0000-4000-8000-000000000002';
    const device = { id: 'mac', userId: 'owner', name: 'Mac', tokenHash: 'hash', lastSeen: new Date().toISOString() };
    const job = { id: jid, status: 'processing', deviceId: 'mac', leaseId: lease, leaseExpires: Date.now() + 300000, clips: [] };
    const pipeline = { set: () => pipeline, exec: async () => [] };
    const redis = { get: async (key: string) => key.startsWith('clipping:device:') ? device : job, pipeline: () => pipeline, incr: async () => 1, expire: async () => 1, eval: async () => 1 } as unknown as Redis;
    const calls: Array<{ model: string; input: unknown }> = [];
    const env = { AI: { run: async (model: string, input: unknown) => { calls.push({ model, input }); return output; } } } as Env;
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => { c.set('redis', redis); await next(); });
    app.onError((error, c) => c.json({ message: error.message }, 400));
    app.route('/', clippingPublicRoutes);
    const send = (extra: Record<string, unknown> = {}, auth = true) => app.request(`/clipping/processor/jobs/${jid}/ai/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${'a'.repeat(64)}` } : {}) }, body: JSON.stringify({ leaseId: lease, model: '@cf/zai-org/glm-4.7-flash', messages: [{ role: 'user', content: 'Find clips using these timestamps.' }], ...extra }) }, env);
    const sendLocal = (task = 'peakcut-local') => app.request('/clipping/processor/local-ai/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${'a'.repeat(64)}` }, body: JSON.stringify({ task, model: '@cf/zai-org/glm-4.7-flash', messages: [{ role: 'user', content: 'Find local clip timestamps.' }] }) }, env);
    return { send, calls, sendLocal };
}

test('clipping AI fixes its model and budget, disables thinking and accepts only structured output', async () => {
    const f = fixture({ choices: [{ finish_reason: 'stop', message: { content: '{"items":[]}' } }] });
    const response = await f.send(); assert.equal(response.status, 200);
    assert.equal(f.calls[0].model, '@cf/zai-org/glm-4.7-flash');
    const input = f.calls[0].input as { max_completion_tokens: number; chat_template_kwargs: { enable_thinking: boolean } };
    assert.equal(input.max_completion_tokens, 4096); assert.equal(input.chat_template_kwargs.enable_thinking, false);
    assert.equal((await response.json() as { choices: Array<{ message: { content: string } }> }).choices[0].message.content, '{"items":[]}');
});

test('clipping AI refuses missing processor auth, stale leases and arbitrary models without inference', async () => {
    const f = fixture({ response: '{"items":[]}' });
    assert.equal((await f.send({}, false)).status, 400);
    assert.equal((await f.send({ leaseId: 'wrong' })).status, 400);
    assert.equal((await f.send({ model: 'another-model' })).status, 400);
    assert.equal(f.calls.length, 0);
});

test('truncated or non-schema model answers cannot masquerade as valid clip selections', async () => {
    for (const output of [{ response: 'Some prose' }, { response: '{"clips":[]}' }, { choices: [{ finish_reason: 'length', message: { content: '{"items":[]}' } }] }]) {
        const f = fixture(output); assert.equal((await f.send()).status, 400);
    }
});

test('paired local clipping uses the same fixed model without uploading a local video job', async () => {
    const f = fixture({ response: '{"items":[]}' });
    assert.equal((await f.sendLocal('arbitrary-task')).status, 400);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.sendLocal()).status, 200);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].model, '@cf/zai-org/glm-4.7-flash');
});
