import { UpstreamError } from '../../lib/errors.ts';

const GRAPH = 'https://graph.facebook.com/v26.0';

interface GraphError { error?: { message?: string } }

async function graphPost<T extends GraphError>(path: string, values: Record<string, string>, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
        response = await fetch(`${GRAPH}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(values),
            signal,
        });
    } catch (err) {
        throw new UpstreamError(`Facebook Reels API unreachable (${(err as Error).message})`, { cause: err });
    }
    const body = await response.json() as T;
    if (!response.ok || body.error) throw new UpstreamError(body.error?.message || `Facebook Reels API returned HTTP ${response.status}`);
    return body;
}

// Facebook's Page Reels API pulls the source from the public R2 URL, so no second media upload is needed.
export async function publishFacebookReel(pageId: string, pageToken: string, mediaUrl: string, caption: string, signal?: AbortSignal): Promise<string> {
    if (!/^\d{1,40}$/.test(pageId)) throw new UpstreamError('The connected Facebook Page ID is invalid.');
    const start = await graphPost<{ video_id?: string; upload_url?: string } & GraphError>(`/${pageId}/video_reels`, {
        access_token: pageToken,
        upload_phase: 'start',
    }, signal);
    if (!start.video_id || !start.upload_url) throw new UpstreamError('Facebook did not create a Reel upload session.');

    let uploadResponse: Response;
    try {
        uploadResponse = await fetch(start.upload_url, {
            method: 'POST',
            headers: { Authorization: `OAuth ${pageToken}`, file_url: mediaUrl },
            signal,
        });
    } catch (err) {
        throw new UpstreamError(`Facebook could not fetch the uploaded video (${(err as Error).message})`, { cause: err });
    }
    const uploaded = await uploadResponse.json() as { success?: boolean; error?: { message?: string } };
    if (!uploadResponse.ok || uploaded.success !== true) throw new UpstreamError(uploaded.error?.message || 'Facebook could not fetch the video from R2.');

    const finished = await graphPost<{ success?: boolean } & GraphError>(`/${pageId}/video_reels`, {
        access_token: pageToken,
        video_id: start.video_id,
        upload_phase: 'finish',
        video_state: 'PUBLISHED',
        description: caption,
    }, signal);
    if (finished.success !== true) throw new UpstreamError('Facebook did not confirm Reel publishing.');
    return start.video_id;
}
