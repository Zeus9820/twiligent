export type ClipJobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
export interface ClipOptions { maxClips: number; minSeconds: number; maxSeconds: number; style: 'clean' | 'bounce' | 'hype'; layout: 'blur' | 'crop' }
export interface ClipOutput { id: string; title: string; description: string; hashtags?: string[]; start: number; end: number; url: string; key: string }
export interface ClipJob {
    id: string; name: string; status: ClipJobStatus; progress: number; stage: string; createdAt: string; updatedAt: string;
    source: { kind: 'upload' | 'url'; url: string; key?: string }; options: ClipOptions; clips: ClipOutput[]; error?: string;
    warning?: string; deviceId?: string; leaseId?: string; leaseExpires?: number;
}
export interface ClipProcessor { id: string; name: string; lastSeen: string; online: boolean }
export interface ClippingDashboard { jobs: ClipJob[]; processors: ClipProcessor[] }
