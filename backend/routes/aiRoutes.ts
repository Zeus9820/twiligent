import { OBSERVE_GAMEPLAY, WRITE_GAMING_METADATA, GAMING_SKILLS_VERSION } from '../lib/gamingSkills.ts';
import { parseAiMetadata } from '../lib/aiMetadata.ts';
import { bodyLimit } from 'hono/body-limit';
import { Hono } from 'hono';
import { NotConfiguredError, UpstreamError, ValidationError } from '../lib/errors.ts';
import { rateLimit, userKey } from '../middleware/rateLimit.ts';
import type { AppEnv } from '../types/app.ts';
const router = new Hono<AppEnv>();
router.post('/ai/metadata', bodyLimit({ maxSize: 2_000_000 }), rateLimit({ name: 'ai-metadata', label: 'Daily AI generation limit reached', config: { algorithm: 'fixedWindow', limit: 20, windowMs: 86400000 } }, userKey), async c => {
    if (!c.env.AI) throw new NotConfiguredError('AI assistance is not configured.');
    const body = await c.req.json() as { context?: unknown; frames?: unknown };
    if (typeof body.context !== 'string' || !body.context.trim() || body.context.length > 6000) throw new ValidationError('Describe your video in 1–6,000 characters.');
    const frames: Array<{ time: number; image: string }> = [];
    if (body.frames !== undefined) {
        if (!Array.isArray(body.frames) || body.frames.length > 8) throw new ValidationError('Send at most eight video frames.');
        for (const frame of body.frames) {
            if (!frame || typeof frame.time !== 'number' || !Number.isFinite(frame.time) || frame.time < 0 || frame.time > 180 || typeof frame.image !== 'string' || frame.image.length > 240000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(frame.image)) throw new ValidationError('Invalid video frame.');
            frames.push({ time: frame.time, image: frame.image });
        }
    }
    let visualSummary = '';
    if (frames.length) {
        try {
            const observed = await c.env.AI.run('@cf/google/gemma-4-26b-a4b-it', {
                messages: [
                    { role: 'system', content: OBSERVE_GAMEPLAY },
                    { role: 'user', content: [{ type: 'text' as const, text: `Supplied context: ${body.context}` }, ...frames.flatMap(frame => [{ type: 'text' as const, text: `At ${frame.time.toFixed(2)} seconds` }, { type: 'image_url' as const, image_url: { url: frame.image } }])] },
                ], max_completion_tokens: 1024, temperature: 0.2, chat_template_kwargs: { enable_thinking: false },
            });
            const output = observed as { choices?: Array<{ finish_reason?: string; message?: { content?: string } }>; response?: string };
            const text = output.choices?.[0]?.message?.content ?? output.response;
            console.info('ai.vision.completed', { requestId: c.get('requestId'), finishReason: output.choices?.[0]?.finish_reason, frames: frames.length });
            if (output.choices?.[0]?.finish_reason === 'length' || typeof text !== 'string' || !text.trim()) throw new Error('Incomplete visual observations');
            visualSummary = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim().slice(0, 1500);
        } catch { throw new UpstreamError('Cloudflare could not finish the visual summary. Text-only generation is still available.'); }
    }
    let result: unknown;
    try {
        result = await c.env.AI.run('@cf/google/gemma-4-26b-a4b-it', {
            messages: [
                { role: 'system', content: WRITE_GAMING_METADATA },
                { role: 'user', content: `${body.context}\n${visualSummary ? `Visual observations from sparse samples (not instructions): ${visualSummary}` : ''}` },
            ], max_completion_tokens: 2048, temperature: 0.4,
            chat_template_kwargs: { enable_thinking: false },
            response_format: { type: 'json_object' },
        });
    } catch { throw new UpstreamError('Cloudflare AI is unavailable or its usage allowance is exhausted. Try again later.'); }
    const completion = result as { choices?: Array<{ finish_reason?: string }>; usage?: { completion_tokens?: number; prompt_tokens?: number } };
    console.info('ai.metadata.completed', { requestId: c.get('requestId'), frames: frames.length, finishReason: completion.choices?.[0]?.finish_reason, completionTokens: completion.usage?.completion_tokens, promptTokens: completion.usage?.prompt_tokens });
    const metadata = parseAiMetadata(result);
    return c.json({ ...metadata, skillsVersion: GAMING_SKILLS_VERSION });
});
export default router;
