import { extractVideoFrames } from '@/lib/videoFrames';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { api } from '../services/api';

export default function AiMetadata({ context, onApply, disabled = false, videoFile }: { videoFile?: File | null; context: string; onApply: (value: { title: string; description: string }) => void; disabled?: boolean }) {
  const controller = useRef<AbortController | null>(null);
  const [analysisProgress, setAnalysisProgress] = useState<number | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const [game, setGame] = useState('');
  const [mission, setMission] = useState('');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [suggestion, setSuggestion] = useState<{ title: string; description: string; summary?: string; titles?: string[] } | null>(null);
  async function generate(analyze = false) {
    setBusy(true); setError(''); setSuggestion(null);
    const run = new AbortController(); controller.current = run;
    try {
      const frames = analyze && videoFile ? await extractVideoFrames(videoFile, setAnalysisProgress, run.signal) : undefined;
      run.signal.throwIfAborted(); setAnalysisProgress(null);
      const result = await api.generateMetadata([game.trim() ? `Game: ${game.trim()}` : '', mission.trim() ? `Mission: ${mission.trim()}` : '', context, details, frames ? 'Summarize the visible clip using these sampled frames.' : ''].filter(Boolean).join('\n').slice(0, 6000), frames);
      if (!run.signal.aborted) setSuggestion(result);
    }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); setAnalysisProgress(null); }
  }
  return <div className="flex flex-col gap-3 rounded-control border p-3">
    <p className="text-sm font-semibold">Gemma 4 writing assistant</p>
    <label className="text-sm">Game<input className="block w-full rounded-control border p-2" value={game} maxLength={120} disabled={disabled || busy} placeholder="e.g. Urban Reign" onChange={event => { setGame(event.target.value); setSuggestion(null); }} /></label>
    <label className="text-sm">Mission / episode<input className="block w-full rounded-control border p-2" value={mission} maxLength={80} disabled={disabled || busy} placeholder="e.g. 73" onChange={event => { setMission(event.target.value); setSuggestion(null); }} /></label>
    <Textarea aria-label="Video context for AI" placeholder="Describe the game, mission and what happens in the clip. AI uses this text; it does not watch the video." value={details} maxLength={4000} onChange={event => { setDetails(event.target.value); setSuggestion(null); }} disabled={disabled || busy} rows={2} />
    <Button type="button" variant="outline" disabled={disabled || busy || !(context.trim() || details.trim() || game.trim())} onClick={() => generate()}>{busy ? 'Generating…' : 'Generate title and description'}</Button>
    {videoFile?.type.startsWith('video/') && <Button type="button" variant="outline" disabled={disabled || busy} onClick={() => generate(true)}>{busy && analysisProgress !== null ? `Selecting frames… ${analysisProgress}%` : 'Analyze video and generate'}</Button>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {suggestion && <div className="flex flex-col gap-2"><p className="font-medium">{suggestion.title}</p>{suggestion.titles?.map(title => <Button key={title} type="button" variant={title === suggestion.title ? 'default' : 'outline'} disabled={disabled || busy} onClick={() => setSuggestion({ ...suggestion, title })}>{title}</Button>)}{suggestion.summary && <p className="text-sm">Visual summary: {suggestion.summary}</p>}<p className="whitespace-pre-wrap text-sm">{suggestion.description}</p><Button type="button" disabled={disabled || busy} onClick={() => { onApply(suggestion); setSuggestion(null); }}>Use suggestion</Button></div>}
    <p className="text-caption text-ink-muted">Visual analysis uses up to eight selected frames, without audio; brief events can be missed. Review before applying. Generation uses your Cloudflare AI allowance. Nothing is published automatically.</p>
  </div>;
}
