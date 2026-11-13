import { useEffect, useState } from 'react';
import SurfaceBox from '@/components/SurfaceBox';
import { Button } from '@/components/ui/button';
import { api } from '../services/api';
import { useAppContext } from '../context/AppContext';

export default function AiPerformanceAnalysis({ accountId }: { accountId?: string }) {
  const { accounts } = useAppContext();
  const channels = accounts.filter(account => account.platform === 'youtube');
  const [selected, setSelected] = useState(accountId ?? channels[0]?.id ?? '');
  const [videos, setVideos] = useState<Array<{ videoId: string; title: string }>>([]);
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [loadingVideos, setLoadingVideos] = useState(false);
  useEffect(() => {
    let active = true;
    setVideos([]); setFirst(''); setSecond(''); setResult(null); setError('');
    if (!selected) return;
    setLoadingVideos(true);
    api.getVideos(selected).then(data => { if (active) setVideos(data.videos); }).catch(err => { if (active) setError((err as Error).message); }).finally(() => { if (active) setLoadingVideos(false); });
    return () => { active = false; };
  }, [selected]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.analyzePerformance>> | null>(null);
  async function analyze() {
    if (!selected) return;
    setBusy(true); setError(''); setResult(null);
    try { setResult(await api.analyzePerformance(selected, first && second ? [first, second] : undefined)); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return <SurfaceBox title="Compare video performance" subheader="Choose two videos to compare measured differences and possible explanations.">
    <div className="flex flex-col gap-3">
      {!accountId && <label>Channel<select className="ml-2 rounded-control border bg-surface p-2" value={selected} disabled={busy} onChange={event => { setSelected(event.target.value); setResult(null); setError(''); }}><option value="">Choose channel</option>{channels.map(channel => <option key={channel.id} value={channel.id}>{channel.title || channel.id}</option>)}</select></label>}
      <p className="text-sm text-ink-muted">Uses lifetime counters from fetched videos. It cannot establish why a video succeeded or compare reporting periods. Results may contain errors.</p>
      <div className="grid gap-3 sm:grid-cols-2">{[{ label: 'First video', value: first, change: setFirst }, { label: 'Second video', value: second, change: setSecond }].map(field => <label key={field.label} className="flex flex-col gap-1 text-sm">{field.label}<select className="rounded-control border bg-surface p-2" value={field.value} disabled={busy || loadingVideos} onChange={event => { field.change(event.target.value); setResult(null); }}><option value="">{loadingVideos ? 'Loading videos…' : 'Choose a video'}</option>{videos.map(video => <option key={video.videoId} value={video.videoId}>{video.title}</option>)}</select></label>)}</div>
      {first && first === second && <p className="text-sm text-danger">Choose two different videos.</p>}
      <Button className="self-start" disabled={busy || !selected || !first || !second || first === second} onClick={analyze}>{busy ? 'Analyzing…' : 'Compare these videos'}</Button>
      {error && <p role="alert" className="text-danger">{error}</p>}
      {result && <div role="status" className="flex flex-col gap-3"><p className="text-sm">{result.model} · {result.facts.videoCount} videos · {result.facts.totalViews.toLocaleString()} views · Source fetched {new Date(result.facts.fetchedAt).toLocaleString()}</p><p className="whitespace-pre-wrap">{result.analysis}</p><details><summary className="cursor-pointer">View source metrics</summary><pre className="max-h-96 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify({ counters: result.facts, supportingData: result.evidence }, null, 2)}</pre></details></div>}
    </div>
  </SurfaceBox>;
}
