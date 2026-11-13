import { useState } from 'react';
import SurfaceBox from '@/components/SurfaceBox';
import { Button } from '@/components/ui/button';
import { api } from '../../../services/api';
export default function InstagramAccountViews({ accountId, totalViews, fetchedPosts, reportedPosts, totalPosts }: { accountId: string; totalViews: number; fetchedPosts: number; reportedPosts: number; totalPosts: number }) {
  const [mode, setMode] = useState('lifetime');
  const [start, setStart] = useState(() => new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
  const [end, setEnd] = useState(() => new Date(Date.now() - 86400000).toISOString().slice(0, 10));
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getIGAccountViews>> | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function load() {
    setBusy(true); setError(''); setData(null);
    try { setData(await api.getIGAccountViews(accountId, start, end)); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  return <SurfaceBox title="Instagram views" subheader="Lifetime post views are shown by default. Date-range account insights are available separately.">
    <div className="flex flex-col gap-3">
    <label className="text-sm">View range<select className="ml-2 rounded-control border bg-surface p-2" value={mode} disabled={busy} onChange={event => setMode(event.target.value)}><option value="lifetime">Lifetime · available posts</option><option value="range">Account views · date range</option></select></label>
    {mode === 'lifetime' ? <>
      <p className="text-3xl font-semibold">{reportedPosts > 0 ? totalViews.toLocaleString() : 'Not reported by Meta'}</p>
      <p className="text-sm">Lifetime view counters reported for {reportedPosts} of {fetchedPosts} fetched posts.</p>
      <p className="text-sm text-ink-muted">{reportedPosts < fetchedPosts || fetchedPosts < totalPosts ? 'Incomplete coverage. ' : ''}This sums available post and Reel counters, not a complete lifetime account metric. Deleted content, expired Stories and unavailable insights are excluded. {fetchedPosts < totalPosts ? `Only ${fetchedPosts} of ${totalPosts} account posts were fetched.` : ''}</p>
    </> : <><div className="flex flex-wrap items-end gap-3">
      <label className="text-sm">Start<input type="date" className="block rounded-control border bg-surface p-2" value={start} disabled={busy} onChange={e => { setStart(e.target.value); setData(null); }} /></label>
      <label className="text-sm">End (inclusive)<input type="date" className="block rounded-control border bg-surface p-2" value={end} disabled={busy} onChange={e => { setEnd(e.target.value); setData(null); }} /></label>
      <Button disabled={busy || !start || !end} onClick={load}>{busy ? 'Loading…' : 'Fetch account views'}</Button>
    </div>
    {error && <p role="alert" className="text-danger">{error}</p>}
    {data && <><p className="text-3xl font-semibold">{data.views === null ? 'Not reported by Meta' : data.views.toLocaleString()}</p><p className="text-sm">{data.start} – {data.end} · UTC · fetched {new Date(data.fetchedAt).toLocaleString()}</p></>}
    <p className="text-sm text-ink-muted">Select up to 30 days. Initial date selection is the last 30 completed UTC days. Instagram may use different boundaries, filters, or reporting delays; identical totals are not guaranteed.</p></>}
    </div>
  </SurfaceBox>;
}
