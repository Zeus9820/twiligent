import PublishedVideoManager from './PublishedVideoManager';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import SurfaceBox from '@/components/SurfaceBox';
import MetricBox from '@/components/MetricBox';
import { api } from '../../../services/api';
import type { YouTubeStudioSummary } from '@shared/types/youtube.ts';

export default function YouTubeStudioPanel({ accountId, connected }: { accountId: string; connected: boolean }) {
  const [data, setData] = useState<YouTubeStudioSummary | null>(null);
  const [error, setError] = useState(() => new URLSearchParams(window.location.search).get('youtube_studio_error') || '');
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setData((await api.getYouTubeStudio(accountId)).data); }
    catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  }, [accountId]);
  useEffect(() => { if (connected) void load(); }, [connected, load]);

  async function connect() {
    setLoading(true); setError('');
    try { window.location.href = (await api.getYouTubeStudioUrl(accountId)).url; }
    catch (err) { setError((err as Error).message); setLoading(false); }
  }

  return (
    <>
    <SurfaceBox title="YouTube Studio analytics" subheader="Private channel insights for the last 28 days. YouTube data may arrive with a delay.">
      <div className="flex flex-col gap-4">
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {!connected && <div><p className="mb-3 text-sm text-ink-muted">Connect the Google account that owns this channel to see watch time and audience activity.</p>
          <Button onClick={connect} disabled={loading}>{loading ? 'Connecting…' : 'Connect YouTube Analytics'}</Button></div>}
        {connected && !data && !error && <p className="text-sm text-ink-muted">Loading YouTube Analytics…</p>}
        {connected && error && <div className="flex gap-2"><Button variant="outline" onClick={load} disabled={loading}>Try again</Button><Button variant="outline" onClick={connect} disabled={loading}>Reconnect</Button></div>}
        {data && <>
          <p className="text-small text-ink-muted">{data.startDate} to {data.endDate}</p>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricBox small label="Views" value={data.views.toLocaleString()} />
            <MetricBox small label="Watch time" value={`${(data.watchMinutes / 60).toFixed(1)} hours`} />
            <MetricBox small label="Average view duration" value={`${Math.round(data.averageViewDurationSeconds)} sec`} />
            <MetricBox small label="Subscribers gained" value={data.subscribersGained.toLocaleString()} subtitle={`${data.subscribersLost.toLocaleString()} lost`} />
          </div>
          {data.topVideos.length > 0 && <div><h4 className="mb-2 font-semibold">Top videos by views</h4><ol className="space-y-2 text-sm">
            {data.topVideos.map(video => <li key={video.videoId}><a className="text-brand-text underline" href={`https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}`} target="_blank" rel="noopener noreferrer">{video.title || `Video ${video.videoId}`}</a> · {video.views.toLocaleString()} views · {(video.watchMinutes / 60).toFixed(1)} watch hours</li>)}
          </ol></div>}
        </>}
      </div>
    </SurfaceBox>
    <Button variant="outline" onClick={connect} disabled={loading}>Reconnect YouTube for video management</Button>
    <PublishedVideoManager key={accountId} accountId={accountId} />
    </>
  );
}
