import { useState } from 'react';
import SurfaceBox from '@/components/SurfaceBox';
import { Button } from '@/components/ui/button';
import { api } from '../services/api';
import { useAppContext } from '../context/AppContext';

export default function AiPerformanceAnalysis({ accountId }: { accountId?: string }) {
  const { accounts } = useAppContext();
  const channels = accounts.filter(account => account.platform === 'youtube');
  const [selected, setSelected] = useState(accountId ?? channels[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.analyzePerformance>> | null>(null);
  async function analyze() {
    if (!selected) return;
    setBusy(true); setError(''); setResult(null);
    try { setResult(await api.analyzePerformance(selected)); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return <SurfaceBox title="AI performance analysis" subheader="GLM 4.7 Flash explains your channel metrics and suggests measurable experiments.">
    <div className="flex flex-col gap-3">
      {!accountId && <label>Channel<select className="ml-2 rounded-control border bg-surface p-2" value={selected} disabled={busy} onChange={event => { setSelected(event.target.value); setResult(null); setError(''); }}><option value="">Choose channel</option>{channels.map(channel => <option key={channel.id} value={channel.id}>{channel.title || channel.id}</option>)}</select></label>}
      <p className="text-sm text-ink-muted">Uses lifetime counters from fetched videos. It cannot establish why a video succeeded or compare reporting periods. Results may contain errors.</p>
      <Button className="self-start" disabled={busy || !selected} onClick={analyze}>{busy ? 'Analyzing…' : 'Analyze performance'}</Button>
      {error && <p role="alert" className="text-danger">{error}</p>}
      {result && <div role="status" className="flex flex-col gap-3"><p className="text-sm">{result.model} · {result.facts.videoCount} videos · {result.facts.totalViews.toLocaleString()} views · Source fetched {new Date(result.facts.fetchedAt).toLocaleString()}</p><p className="whitespace-pre-wrap">{result.analysis}</p><details><summary className="cursor-pointer">View source metrics</summary><pre className="max-h-96 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(result.facts, null, 2)}</pre></details></div>}
    </div>
  </SurfaceBox>;
}
