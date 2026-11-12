import { UpstreamError } from './errors.ts';
export function parseAiMetadata(result: unknown): { title: string; description: string; summary?: string } {
    const output = result as { response?: unknown; choices?: Array<{ finish_reason?: string; message?: { content?: string | Array<{ type?: string; text?: string }> } }> } | null;
    if (output?.choices?.[0]?.finish_reason === 'length') throw new UpstreamError('AI response was cut short. Please generate again with a shorter clip description.');
    const content = output?.choices?.[0]?.message?.content;
    const raw = typeof output?.response === 'string' ? output.response : typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part.type === 'text').map(part => part.text ?? '').join('') : '';
    const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    let parsed: unknown;
    try {
        const start = text.indexOf('{'); const end = text.lastIndexOf('}');
        parsed = JSON.parse(start >= 0 && end >= start ? text.slice(start, end + 1) : text);
    } catch { throw new UpstreamError('AI could not produce structured metadata. Please try again.'); }
    if (!parsed || typeof parsed !== 'object') throw new UpstreamError('AI returned empty metadata. Please try again.');
    const value = parsed as { title?: unknown; description?: unknown; summary?: unknown };
    if (typeof value.title !== 'string' || !value.title.trim() || [...value.title].length > 100 || typeof value.description !== 'string' || value.description.length > 5000 || /[<>]/.test(value.title + value.description)) throw new UpstreamError('AI returned unsuitable metadata. Please try again.');
    return { title: value.title.trim(), description: value.description, ...(typeof value.summary === 'string' ? { summary: value.summary.slice(0, 600) } : {}) };
}
