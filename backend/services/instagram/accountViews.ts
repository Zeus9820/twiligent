import { igFetch } from './instagramApi.ts';
import { ValidationError } from '../../lib/errors.ts';
export async function fetchAccountViews(igUserId: string, accessToken: string, start: string, end: string, signal?: AbortSignal) {
    const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    if (!validDate(start) || !validDate(end)) throw new ValidationError('Choose valid start and end dates.');
    const since = Date.parse(start); const until = Date.parse(end) + 86400000;
    if (until <= since || until - since > 30 * 86400000 || since > Date.now()) throw new ValidationError('Choose a date range of 1–30 days.');
    const response = await igFetch<{ data?: Array<{ name?: string; total_value?: { value?: unknown } }> }>(`/${igUserId}/insights`, { access_token: accessToken, metric: 'views', period: 'day', metric_type: 'total_value', since: String(since / 1000), until: String(until / 1000) }, 0, signal);
    const raw = response.data?.find(item => item.name === 'views')?.total_value?.value;
    const views = raw !== null && raw !== undefined && raw !== '' && Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : null;
    return { views, start, end, timezone: 'UTC', fetchedAt: new Date().toISOString(), source: 'Meta account insights: views' };
}
