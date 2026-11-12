export interface FrameFeature { time: number; pixels: number[]; histogram: number[]; variance: number }
export interface VideoFrame { time: number; image: string }
export function frameDistance(a: FrameFeature, b: FrameFeature): number {
  const spatial = a.pixels.reduce((sum, value, i) => sum + Math.abs(value - b.pixels[i]), 0) / a.pixels.length / 255;
  const histogram = a.histogram.reduce((sum, value, i) => sum + Math.abs(value - b.histogram[i]), 0) / 2;
  return spatial * 0.6 + histogram * 0.4;
}
// Greedy temporal coverage plus visual novelty. Only descriptors are retained while scanning.
export function selectFrames(frames: FrameFeature[], limit = 8): FrameFeature[] {
  const useful = frames.filter(frame => frame.variance > 12);
  const candidates = useful.length ? useful : frames;
  if (!candidates.length || limit <= 0) return [];
  const selected: FrameFeature[] = [candidates[0]];
  const duration = Math.max(1, candidates.at(-1)!.time - candidates[0].time);
  while (selected.length < Math.min(limit, candidates.length)) {
    let best: FrameFeature | undefined; let score = -1;
    for (const candidate of candidates) {
      if (selected.includes(candidate)) continue;
      const novelty = Math.min(...selected.map(frame => frameDistance(frame, candidate)));
      const coverage = Math.min(...selected.map(frame => Math.abs(frame.time - candidate.time))) / duration;
      // Avoid near-identical frames unless needed to cover a distant part of the clip.
      if (novelty < 0.035 && coverage < 0.2) continue;
      const index = frames.indexOf(candidate);
      const cut = index > 0 ? frameDistance(frames[index - 1], candidate) : 0;
      const value = novelty * 0.55 + coverage * 0.35 + cut * 0.1;
      if (value > score) { score = value; best = candidate; }
    }
    if (!best) break;
    selected.push(best);
  }
  return selected.sort((a, b) => a.time - b.time);
}
export async function extractVideoFrames(file: File, onProgress: (value: number) => void, signal: AbortSignal): Promise<VideoFrame[]> {
  const video = document.createElement('video');
  const url = URL.createObjectURL(file);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) { URL.revokeObjectURL(url); throw new Error('Frame analysis is unavailable in this browser.'); }
  function wait(event: 'loadedmetadata' | 'seeked', start: () => void) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Video decoding timed out.')), 15000);
      const cleanup = () => { clearTimeout(timer); video.removeEventListener(event, success); video.removeEventListener('error', failure); signal.removeEventListener('abort', aborted); };
      const finish = (error?: Error) => { cleanup(); if (error) reject(error); else resolve(); };
      const success = () => finish(); const failure = () => finish(new Error('This video could not be decoded.')); const aborted = () => finish(new DOMException('Analysis cancelled', 'AbortError'));
      video.addEventListener(event, success, { once: true }); video.addEventListener('error', failure, { once: true }); signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted(); else start();
    });
  }
  async function seek(time: number) { signal.throwIfAborted(); if (video.readyState >= 2 && Math.abs(video.currentTime - time) < 0.001) return; await wait('seeked', () => { video.currentTime = time; }); }
  try {
    video.muted = true; video.preload = 'auto';
    await wait('loadedmetadata', () => { video.src = url; });
    if (!Number.isFinite(video.duration) || video.duration <= 0 || video.duration > 180) throw new Error('Choose a video up to three minutes for visual analysis.');
    const count = Math.min(90, Math.max(3, Math.ceil(video.duration / 2)));
    const features: FrameFeature[] = [];
    canvas.width = 16; canvas.height = 9;
    for (let i = 0; i < count; i++) {
      const time = Math.min(video.duration - 0.01, (i + 0.5) * video.duration / count);
      await seek(Math.max(0, time)); ctx.drawImage(video, 0, 0, 16, 9);
      const rgba = ctx.getImageData(0, 0, 16, 9).data;
      const pixels: number[] = []; const histogram = Array<number>(16).fill(0);
      for (let j = 0; j < rgba.length; j += 4) { const value = (rgba[j] + rgba[j + 1] + rgba[j + 2]) / 3; pixels.push(value); histogram[Math.min(15, Math.floor(value / 16))] += 1 / 144; }
      const mean = pixels.reduce((a, b) => a + b, 0) / pixels.length;
      features.push({ time: video.currentTime, pixels, histogram, variance: pixels.reduce((sum, value) => sum + (value - mean) ** 2, 0) / pixels.length });
      onProgress(Math.round((i + 1) / count * 85));
    }
    const selected = selectFrames(features); const result: VideoFrame[] = [];
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale)); canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    for (const frame of selected) { await seek(frame.time); ctx.drawImage(video, 0, 0, canvas.width, canvas.height); result.push({ time: frame.time, image: canvas.toDataURL('image/jpeg', 0.7) }); }
    onProgress(100); return result;
  } finally { video.pause(); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); canvas.width = 0; canvas.height = 0; }
}
