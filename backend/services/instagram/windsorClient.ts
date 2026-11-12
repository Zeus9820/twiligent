import { UpstreamError } from '../../lib/errors.ts';

const WINDSOR_MCP_URL = 'https://mcp.windsor.ai/';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface RpcResult {
    error?: { message?: string };
    result?: {
        isError?: boolean;
        content?: Array<{ type?: string; text?: string }>;
        structuredContent?: { result?: Json; error?: string };
    };
}

function decodeResponse(body: string, contentType: string): RpcResult {
    if (contentType.includes('text/event-stream')) {
        const data = body.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        return JSON.parse(data) as RpcResult;
    }
    return JSON.parse(body) as RpcResult;
}

/** Calls Windsor's remote MCP server. Do not retry writes: the outcome can be unknown after a timeout. */
export async function callWindsorTool(apiKey: string, name: string, args: Record<string, Json>, signal?: AbortSignal): Promise<Json> {
    let response: Response;
    try {
        response = await fetch(WINDSOR_MCP_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
            signal,
        });
    } catch {
        throw new UpstreamError('Could not reach Windsor. The outcome of a publishing request may be unknown.');
    }
    if (!response.ok) throw new UpstreamError(`Windsor returned HTTP ${response.status}.`);
    let body: RpcResult;
    try {
        body = decodeResponse(await response.text(), response.headers.get('content-type') ?? '');
    } catch {
        throw new UpstreamError('Windsor returned an invalid response.');
    }
    const error = body.error?.message || body.result?.structuredContent?.error || (body.result?.isError ? body.result.content?.find(item => item.type === 'text')?.text : undefined);
    if (error && /trial includes the last 30 days of data history/i.test(error)) {
        throw new UpstreamError('Windsor trial history is limited to 30 days.', { reason: 'windsor_trial_history_limit' });
    }
    if (error || !body.result || body.result.isError) throw new UpstreamError('Windsor could not complete the request. Check the connection and account permissions.');
    if (body.result.structuredContent?.result !== undefined) return body.result.structuredContent.result;
    const text = body.result.content?.find(item => item.type === 'text')?.text;
    if (!text) throw new UpstreamError('Windsor returned no result.');
    try { return JSON.parse(text) as Json; } catch { throw new UpstreamError('Windsor returned an invalid result.'); }
}
