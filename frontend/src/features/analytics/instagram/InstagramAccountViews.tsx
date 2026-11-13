import { useEffect, useState } from 'react';
import SurfaceBox from '@/components/SurfaceBox';
import { Button } from '@/components/ui/button';
import { api } from '../../../services/api';
export default function InstagramAccountViews({ accountId }: { accountId: string }) {
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
  useEffect(() => { void load(); }, []);
  return <SurfaceBox title="Account views · Meta Insights" subheader="Compare this metric with Instagram Insights using the same dates. It is separate from the fetched-post total below.">
    <div className="flex flex-col gap-3"><div className="flex flex-wrap items-end gap-3">
      <label className="text-sm">Start<input type="date" className="block rounded-control border bg-surface p-2" value={start} disabled={busy} onChange={e => { setStart(e.target.value); setData(null); }} /></label>
      <label className="text-sm">End (inclusive)<input type="date" className="block rounded-control border bg-surface p-2" value={end} disabled={busy} onChange={e => { setEnd(e.target.value); setData(null); }} /></label>
      <Button disabled={busy || !start || !end} onClick={load}>{busy ? 'Loading…' : 'Fetch account views'}</Button>
    </div>
    {error && <p role="alert" className="text-danger">{error}</p>}
    {data && <><p className="text-3xl font-semibold">{data.views === null ? 'Not reported by Meta' : data.views.toLocaleString()}</p><p className="text-sm">{data.start} – {data.end} · UTC · fetched {new Date(data.fetchedAt).toLocaleString()}</p></>}
    <p className="text-sm text-ink-muted">Select up to 30 days. Defaults to the last 30 completed UTC days. Instagram may use different boundaries, filters, or reporting delays; identical totals are not guaranteed.</p></div>
  </SurfaceBox>;
}
