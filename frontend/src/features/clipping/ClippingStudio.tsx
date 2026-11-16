import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Download, Laptop, LoaderCircle, Pencil, Save, Scissors, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import PageHeader from '@/components/PageHeader';
import SurfaceBox from '@/components/SurfaceBox';
import { EmptyState } from '@/components/StateViews';
import { api } from '../../services/api';
import { useAppContext } from '../../context/AppContext';
import { useMediaStorageConfig } from '../../hooks/use-media-storage-config';
import { timeAgo } from '../../utils/formatters';
import type { CaptionTask, ClipCaptionWord, ClipJob, ClipOptions, ClippingDashboard } from '@shared/types/clipping.ts';

const DEFAULTS: ClipOptions = { maxClips: 3, minSeconds: 15, maxSeconds: 60, style: 'clean', layout: 'blur' };
const field = 'h-10 w-full rounded-field border border-input bg-surface-raised px-3 text-sm text-ink';

function duration(from: string, to: number): string {
  const seconds = Math.max(0, Math.floor((to - new Date(from).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return 'Unavailable';
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function guidance(job: ClipJob, online: boolean): string {
  if (job.status === 'queued') return online ? 'The Mac will pick up queued work when available.' : 'Start the Mac processor and keep your Mac awake.';
  if (job.status === 'failed') return 'Review the error above, then retry when the cause is resolved.';
  if (job.status === 'completed') return 'Processing and upload have finished.';
  if (!online) return 'The Mac appears offline. Keep it awake and check the processor connection.';
  if (job.leaseExpires && job.leaseExpires < Date.now()) return 'The processor stopped reporting. Check your Mac, then restart the stalled job.';
  if (/render|finish/i.test(job.stage)) return 'Rendering includes video effects, captions and audio. Progress may pause while each clip finishes.';
  if (/upload/i.test(job.stage)) return 'The Mac is uploading finished clips. Keep it connected to the internet.';
  if (/transcri|writing|reading/i.test(job.stage)) return 'The Mac is preparing speech and timestamps. Longer videos take more time.';
  if (/finding|AI/i.test(job.stage)) return 'The AI is selecting moments from the transcript.';
  return 'The Mac is processing this video. Keep it awake and connected.';
}

export default function ClippingStudio() {
  const { showToast } = useAppContext();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<ClippingDashboard>({ jobs: [], processors: [] });
  const [error, setError] = useState('');
  const [pairCode, setPairCode] = useState(params.get('pair') || '');
  const [pairing, setPairing] = useState(false);
  const [mode, setMode] = useState<'upload' | 'url'>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [options, setOptions] = useState<ClipOptions>(DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [pendingAction, setPendingAction] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'completed'>('all');
  const [captionClipId, setCaptionClipId] = useState('');
  const [captionTaskId, setCaptionTaskId] = useState('');
  const [captionWords, setCaptionWords] = useState<ClipCaptionWord[]>([]);
  const [captionBusy, setCaptionBusy] = useState(false);
  const [captionStage, setCaptionStage] = useState('');
  const [captionError, setCaptionError] = useState('');
  const storage = useMediaStorageConfig();
  const alive = useRef(true);
  const pending = useRef<{ id: string; source?: ClipJob['source']; file?: File; url: string; mode: string; options: string } | null>(null);

  const refresh = useCallback(async () => {
    try { const result = await api.getClipping(); if (alive.current) { setData(result); setError(''); } }
    catch (problem) { if (alive.current) setError((problem as Error).message); }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 10000);
    return () => { alive.current = false; window.clearInterval(timer); };
  }, [refresh]);

  async function pair() {
    setPairing(true); setError('');
    try { await api.pairClipProcessor(pairCode); setPairCode(''); setParams({}, { replace: true }); showToast('Mac connected. The processor will appear shortly.'); await refresh(); }
    catch (problem) { setError((problem as Error).message); }
    finally { setPairing(false); }
  }
  async function create() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (mode === 'upload' && (!file || file.size > 2 * 1024 ** 3)) throw new Error('Choose an MP4 or MOV video up to 2 GB.');
      if (mode === 'url' && !url.trim()) throw new Error('Enter a public video URL.');
      if (options.minSeconds >= options.maxSeconds) throw new Error('Maximum duration must exceed minimum duration.');
      if (!pending.current || pending.current.file !== file || pending.current.url !== url || pending.current.mode !== mode || pending.current.options !== JSON.stringify(options)) pending.current = { id: crypto.randomUUID(), file: file || undefined, url, mode, options: JSON.stringify(options) };
      const attempt = pending.current;
      if (!attempt.source) {
        if (mode === 'upload') {
          if (!storage) throw new Error('Video storage is unavailable. Try refreshing the page.');
          setProgress(0);
          const uploaded = await api.uploadMedia(file!, storage, { onProgress: setProgress, resumeKey: `clipping:${attempt.id}` });
          attempt.source = { kind: 'upload', url: uploaded };
        } else attempt.source = { kind: 'url', url: url.trim() };
      }
      const result = await api.createClipJob({ id: attempt.id, name: mode === 'upload' ? file!.name : url.trim(), source: attempt.source, options });
      setSelectedId(result.job.id); pending.current = null; setFile(null); setUrl('');
      showToast('Video queued. Your Mac will process it when online.'); await refresh();
    } catch (problem) { setError((problem as Error).message); }
    finally { setBusy(false); setProgress(null); }
  }
  async function jobAction(job: ClipJob, action: 'cancel' | 'retry') {
    setPendingAction(job.id);
    try { await (action === 'cancel' ? api.cancelClipJob(job.id) : api.retryClipJob(job.id)); await refresh(); }
    catch (problem) { setError((problem as Error).message); }
    finally { setPendingAction(''); }
  }
  async function download(job: ClipJob, clipId: string) {
    setPendingAction(clipId);
    try {
      const blob = await api.downloadClip(job.id, clipId); const local = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = local; link.download = `${clipId}.mp4`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(local), 60000);
    } catch (problem) { setError((problem as Error).message); }
    finally { setPendingAction(''); }
  }
  async function waitForCaptionTask(taskId: string): Promise<CaptionTask> {
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      const { task } = await api.getClipCaptionTask(taskId);
      setCaptionStage(task.stage);
      if (task.status === 'completed' || task.status === 'failed') return task;
      await new Promise(resolve => window.setTimeout(resolve, 3000));
    }
    throw new Error('The Mac is taking longer than expected. Your edit is still safe; check the task again in a moment.');
  }
  async function openCaptionEditor(job: ClipJob, clip: ClipJob['clips'][number]) {
    setCaptionClipId(clip.id); setCaptionTaskId(''); setCaptionError(''); setCaptionBusy(true); setCaptionStage('Sending the caption request to your Mac');
    try {
      const { task: created } = await api.inspectClipCaptions(job.id, clip.id); setCaptionTaskId(created.id);
      const task = await waitForCaptionTask(created.id);
      if (task.status !== 'completed' || !task.words?.length) throw new Error(task.error || 'The Mac could not load timed captions for this clip.');
      setCaptionWords(task.words); setCaptionTaskId(created.id); setCaptionStage('Captions ready to edit');
    } catch (problem) { setCaptionError((problem as Error).message); }
    finally { setCaptionBusy(false); }
  }
  async function saveCaptionEditor(job: ClipJob, clipId: string) {
    if (!captionTaskId || !captionWords.length || captionBusy) return;
    setCaptionBusy(true); setCaptionError(''); setCaptionStage('Queueing the revised clip for your Mac');
    try {
      const { task: created } = await api.renderClipCaptions(job.id, clipId, captionTaskId, captionWords.map(word => word.text));
      const task = await waitForCaptionTask(created.id);
      if (task.status !== 'completed') throw new Error(task.error || 'The Mac could not render this caption edit. The existing clip is unchanged.');
      setCaptionClipId(''); setCaptionTaskId(''); setCaptionWords([]); setCaptionStage('');
      showToast('Caption edit saved. The revised clip is ready.'); await refresh();
    } catch (problem) { setCaptionError((problem as Error).message); }
    finally { setCaptionBusy(false); }
  }
  const online = data.processors.some(processor => processor.online);
  const selected = data.jobs.find(job => job.id === selectedId) || data.jobs[0];
  const jobs = data.jobs.filter(job => filter === 'all' || (filter === 'completed' ? job.status === 'completed' : job.status === 'queued' || job.status === 'processing'));

  return <div className="flex flex-col gap-6">
    <PageHeader title="Clipping studio" description="Turn longer videos into vertical clips. Gemini selects highlights; your Mac renders them." />
    {error && <p role="alert" className="rounded-card border border-danger/30 bg-danger/5 p-4 text-small text-danger">{error}</p>}
    <SurfaceBox title="Mac processor" secondary={<Laptop className={online ? 'size-5 text-success' : 'size-5 text-ink-faint'} />} subheader={online ? 'Online — ready to process your videos' : 'Offline — queued videos wait until your Mac connects'}>
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="flex-1">
          {data.processors.map(processor => <div key={processor.id} className="mb-2 flex flex-wrap items-center gap-3 text-small"><span className={`size-2 rounded-full ${processor.online ? 'bg-success' : 'bg-ink-faint'}`} /><span>{processor.name}</span><span className="text-ink-faint">{processor.online ? 'Connected' : `Last seen ${timeAgo(processor.lastSeen)}`}</span><Button variant="ghost" size="sm" onClick={async () => { try { await api.disconnectClipProcessor(processor.id); await refresh(); } catch (problem) { setError((problem as Error).message); } }}>Disconnect</Button></div>)}
          <p className="text-small text-ink-muted">Keep your Mac awake and the Studio processor running. No domain or tunnel is required.</p>
        </div>
        <div className="flex max-w-full flex-col gap-2"><label htmlFor="processor-code" className="text-small font-medium">Pair this Mac</label><div className="flex gap-2"><input id="processor-code" value={pairCode} onChange={event => setPairCode(event.target.value.toUpperCase())} maxLength={12} placeholder="10-character code" className={`${field} max-w-[13rem] font-mono`} /><Button disabled={pairing || pairCode.replace(/[\s-]/g, '').length !== 10} onClick={() => void pair()}>{pairing ? 'Pairing…' : 'Connect'}</Button></div><p className="text-caption text-ink-faint">Use the code shown by the Mac processor.</p></div>
      </div>
    </SurfaceBox>
    <SurfaceBox title="Create clips" subheader="Upload an MP4/MOV or use a public YouTube, Twitch or Kick video. Up to 2 hours per video.">
      <div className="mb-4 flex gap-2"><Button variant={mode === 'upload' ? 'default' : 'outline'} disabled={busy} onClick={() => setMode('upload')}>Upload video</Button><Button variant={mode === 'url' ? 'default' : 'outline'} disabled={busy} onClick={() => setMode('url')}>Video link</Button></div>
      {mode === 'upload' ? <label className="flex cursor-pointer flex-col items-center gap-2 rounded-card border border-dashed border-line p-6 text-center"><Upload className="size-6 text-brand" /><span className="text-small font-medium">{file ? file.name : 'Choose an MP4 or MOV video'}</span><span className="text-caption text-ink-faint">{file ? `${(file.size / 1024 ** 2).toFixed(1)} MB` : 'Up to 2 GB'}</span><input disabled={busy} type="file" accept="video/mp4,video/quicktime,.mp4,.mov" onChange={event => setFile(event.target.files?.[0] ?? null)} className="max-w-full text-small" /></label> : <input disabled={busy} aria-label="Source video URL" placeholder="https://www.youtube.com/watch?v=…" value={url} onChange={event => setUrl(event.target.value)} className={field} />}
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <label className="flex flex-col gap-1.5 text-small">Clips<input type="number" min={1} max={6} value={options.maxClips} disabled={busy} onChange={event => setOptions(current => ({ ...current, maxClips: Number(event.target.value) }))} className={field} /></label>
        <label className="flex flex-col gap-1.5 text-small">Minimum seconds<input type="number" min={5} max={60} disabled={busy} value={options.minSeconds} onChange={event => setOptions(current => ({ ...current, minSeconds: Number(event.target.value) }))} className={field} /></label>
        <label className="flex flex-col gap-1.5 text-small">Maximum seconds<input type="number" min={10} max={90} disabled={busy} value={options.maxSeconds} onChange={event => setOptions(current => ({ ...current, maxSeconds: Number(event.target.value) }))} className={field} /></label>
        <label className="flex flex-col gap-1.5 text-small">Captions<select disabled={busy} value={options.style} onChange={event => setOptions(current => ({ ...current, style: event.target.value as ClipOptions['style'] }))} className={field}><option value="clean">Clean</option><option value="bounce">Bounce</option><option value="hype">Hype</option></select></label>
        <label className="flex flex-col gap-1.5 text-small">Vertical layout<select disabled={busy} value={options.layout} onChange={event => setOptions(current => ({ ...current, layout: event.target.value as ClipOptions['layout'] }))} className={field}><option value="blur">Fit with blurred background</option><option value="crop">Center crop</option></select></label>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><p className="max-w-2xl text-caption text-ink-faint">Highlights use speech and audio activity. Gameplay with little dialogue may produce fewer useful clips. AI usage shares your Cloudflare allowance.</p><Button disabled={busy || (mode === 'upload' ? !file : !url.trim())} onClick={() => void create()}>{busy ? <LoaderCircle className="size-4 animate-spin" /> : <Scissors className="size-4" />}{busy ? progress !== null ? `Uploading ${progress}%` : 'Adding job…' : online ? 'Generate clips' : 'Queue for my Mac'}</Button></div>
      {progress !== null && <progress aria-label="Source upload progress" className="mt-3 h-2 w-full accent-brand" value={progress} max={100} />}
    </SurfaceBox>
    <div className="grid gap-4 xl:grid-cols-[minmax(17rem,0.7fr)_minmax(24rem,1.3fr)]">
      <SurfaceBox title="Video jobs" subheader="Latest 30 jobs. Nothing is published automatically.">
        <div className="mb-3 flex flex-wrap gap-2">{(['all', 'active', 'completed'] as const).map(value => <Button key={value} size="sm" variant={filter === value ? 'default' : 'outline'} onClick={() => setFilter(value)}>{value === 'all' ? 'All' : value === 'active' ? 'In progress' : 'Ready'}</Button>)}</div>
        {!jobs.length && <EmptyState icon={<Scissors />} title="No videos here yet" description="Add a video to start creating clips." />}
        <div className="flex max-h-[38rem] flex-col gap-2 overflow-y-auto">{jobs.map(job => <button key={job.id} type="button" onClick={() => setSelectedId(job.id)} className={`rounded-control border p-3 text-left ${selected?.id === job.id ? 'border-brand/50 bg-brand/5' : 'border-line hover:bg-surface-sunken'}`}><p className="line-clamp-2 text-small font-semibold">{job.name}</p><p className="mt-1 text-caption text-ink-muted">{job.stage} · {Math.round(job.progress * 100)}%</p><progress className="mt-2 h-1.5 w-full accent-brand" value={job.progress} max={1} /><p className="mt-1 text-caption text-ink-faint">{timeAgo(job.createdAt)} · {job.clips.length} clips</p></button>)}</div>
      </SurfaceBox>
      <SurfaceBox title={selected?.name || 'Your clips'} subheader={selected?.stage || 'Select a video to preview its clips.'}>
        {!selected ? <EmptyState icon={<Scissors />} title="Ready when you are" description="Generated clips will appear here for review and publishing." /> : <>
          <div className="mb-4 flex items-center justify-between gap-3"><span className="inline-flex items-center gap-2 text-small text-ink-muted">{selected.status === 'completed' ? <CheckCircle2 className="size-4 text-success" /> : selected.status === 'processing' ? <LoaderCircle className="size-4 animate-spin" /> : null}{selected.status}</span>{selected.status === 'queued' || selected.status === 'processing' ? <Button size="sm" variant="outline" disabled={pendingAction === selected.id} onClick={() => void jobAction(selected, 'cancel')}><X className="size-4" />Cancel</Button> : selected.status === 'failed' || selected.status === 'cancelled' ? <Button size="sm" variant="outline" disabled={pendingAction === selected.id} onClick={() => void jobAction(selected, 'retry')}>Retry</Button> : null}{selected.status === 'processing' && (selected.leaseExpires ?? Infinity) < Date.now() && <Button size="sm" variant="outline" onClick={() => void jobAction(selected, 'retry')}>Restart stalled job</Button>}</div>
          {selected.error && <p className="mb-3 text-small text-danger">{selected.error}</p>}{selected.warning && <p className="mb-3 text-small text-ink-muted">{selected.warning}</p>}
          {selected.status === 'completed' && selected.clips.length > 0 && <div className="mb-4"><Link to={`/upload?clipBatch=${encodeURIComponent(selected.id)}`} className="inline-flex h-10 items-center rounded-control bg-brand px-4 text-small font-medium text-white">Publish all clips</Link><p className="mt-1 text-caption text-ink-faint">Review each clip and choose Instagram and YouTube before publishing.</p></div>}
          <section aria-label="Processing details" className="mb-4 rounded-card border border-line bg-surface-sunken p-4">
            <h3 className="text-small font-semibold">Processing details</h3>
            <div className="mt-3 grid grid-cols-2 gap-3 text-small">
              <div><p className="text-ink-faint">Current step</p><p>{selected.stage}</p></div>
              <div><p className="text-ink-faint">Overall progress</p><p>{Math.round(selected.progress * 100)}%</p></div>
              <div><p className="text-ink-faint">Elapsed since queued</p><p>{duration(selected.createdAt, selected.status === 'processing' || selected.status === 'queued' ? Date.now() : new Date(selected.updatedAt).getTime())}</p></div>
              <div><p className="text-ink-faint">Last processor update</p><p>{timeAgo(selected.updatedAt)}</p></div>
            </div>
            <p className="mt-3 text-caption text-ink-muted">{guidance(selected, online)}</p>
            <p className="mt-1 text-caption text-ink-faint">Updates arrive about every 15 seconds. Clips appear after rendering and upload.</p>
          </section>
          {selected.clips.length === 0 ? <p className="py-8 text-center text-small text-ink-muted">{selected.status === 'queued' ? 'Waiting for your Mac to pick up this video.' : selected.status === 'completed' ? 'No highlights were found. Try a video with more dialogue or reactions.' : 'Clips will appear after processing and upload finish.'}</p> : <div className="grid gap-4 md:grid-cols-2">{selected.clips.map(clip => <article key={clip.id} className="overflow-hidden rounded-card border border-line"><video src={clip.url} controls preload="none" className="aspect-[9/16] max-h-[28rem] w-full bg-black object-contain" /><div className="p-3"><h3 className="text-small font-semibold">{clip.title}</h3><p className="mt-1 text-caption text-ink-faint">{Math.round(clip.end - clip.start)} seconds · {Math.round(clip.start)}s–{Math.round(clip.end)}s</p><p className="mt-2 line-clamp-3 text-small text-ink-muted">{clip.description}</p><div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={pendingAction === clip.id} onClick={() => void download(selected, clip.id)}><Download className="size-3.5" />Download</Button><Button size="sm" variant="outline" disabled={!online || captionBusy} onClick={() => void openCaptionEditor(selected, clip)}><Pencil className="size-3.5" />Edit on-video captions</Button><Link to={`/upload?clipJob=${selected.id}&clip=${clip.id}`} className="inline-flex h-8 items-center rounded-control bg-brand px-3 text-small font-medium text-white">Use in Publish</Link></div>
            {captionClipId === clip.id && <section className="mt-4 rounded-control border border-line bg-surface-sunken p-3" aria-label="Edit spoken captions"><h4 className="text-small font-semibold">Words shown in the video</h4><p className="mt-1 text-caption text-ink-muted">Correct one word at a time. Timing and effects stay aligned. The old clip remains available until the new render finishes.</p>{captionBusy && <p className="mt-3 flex items-center gap-2 text-small text-ink-muted"><LoaderCircle className="size-4 animate-spin" />{captionStage || 'Working on your Mac…'}</p>}{captionError && <p role="alert" className="mt-3 text-small text-danger">{captionError}</p>}{captionWords.length > 0 && <div className="mt-3 max-h-72 space-y-2 overflow-y-auto">{captionWords.map((word, index) => <label key={`${word.start}-${index}`} className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-caption"><span className="text-ink-faint">{word.start.toFixed(1)}s</span><input aria-label={`Caption word ${index + 1} at ${word.start.toFixed(1)} seconds`} maxLength={80} value={word.text} disabled={captionBusy} onChange={event => setCaptionWords(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, text: event.target.value } : item))} className={`${field} h-9`} /></label>)}</div>}{captionWords.length > 0 && <div className="mt-3 flex gap-2"><Button size="sm" disabled={captionBusy || !online || captionWords.some(word => !word.text.trim() || /\s/.test(word.text.trim()))} onClick={() => void saveCaptionEditor(selected, clip.id)}><Save className="size-3.5" />{captionBusy ? 'Rendering…' : 'Save and re-render'}</Button><Button size="sm" variant="outline" disabled={captionBusy} onClick={() => { setCaptionClipId(''); setCaptionTaskId(''); setCaptionWords([]); setCaptionError(''); }}>Close</Button></div>}</section>}
          </div></article>)}</div>}
        </>}
      </SurfaceBox>
    </div>
    <p className="text-caption text-ink-faint">Powered by PeakCut (MIT) and Gemini. Rendering runs on your Mac. Review every clip before posting.</p>
  </div>;
}
