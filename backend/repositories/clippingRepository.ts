import { ConflictError, NotConfiguredError, NotFoundError } from '../lib/errors.ts';
import type { Redis } from '../types/app.ts';
import type { ClipJob } from '../../shared/types/clipping.ts';
import type { CaptionTask } from '../../shared/types/clipping.ts';
const TTL = 30 * 86400;
function normalize(job: ClipJob): ClipJob { return { ...job, clips: Array.isArray(job.clips) ? job.clips : [] }; }
export const clippingKey = (user: string) => `clipping:v1:${user}`;
export const captionTaskKey = (user: string, task: string) => `${clippingKey(user)}:caption-task:${task}`;
export const captionQueueKey = (user: string, device: string) => `${clippingKey(user)}:caption-queue:${device}`;
const CAPTION_TTL = 7 * 86400;
export function createClippingRepository(client: Redis | null) {
    function db() { if (!client) throw new NotConfiguredError('Clipping job storage is unavailable.'); return client; }
    return {
        async create(user: string, job: ClipJob) {
            const p = clippingKey(user);
            const inserted = await db().eval<unknown[], number>(`if redis.call('EXISTS',KEYS[1])==1 then return 0 end
if redis.call('ZCARD',KEYS[3])>=5 then return -1 end
redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[4]); redis.call('ZADD',KEYS[2],ARGV[2],ARGV[3]); redis.call('ZADD',KEYS[3],ARGV[2],ARGV[3]); redis.call('EXPIRE',KEYS[2],ARGV[4]); redis.call('EXPIRE',KEYS[3],ARGV[4]); return 1`, [`${p}:job:${job.id}`, `${p}:jobs`, `${p}:queue`], [JSON.stringify(job), Date.parse(job.createdAt), job.id, TTL]);
            if (inserted === -1) throw new ConflictError('Five videos are already queued. Wait for a job to finish.');
            return this.get(user, job.id);
        },
        async createReady(user: string, job: ClipJob) {
            const p = clippingKey(user);
            const prefix = `${user}/clipping/local-batches/${job.id}/`;
            const raw = await db().eval<unknown[], string>(`local old=redis.call('GET',KEYS[1]); if old then local j=cjson.decode(old); if j.source and j.source.key and string.find(j.source.key,ARGV[5],1,true)==1 then return old end; return '' end
redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[4]); redis.call('ZADD',KEYS[2],ARGV[2],ARGV[3]); redis.call('EXPIRE',KEYS[2],ARGV[4]); return ARGV[1]`, [`${p}:job:${job.id}`, `${p}:jobs`], [JSON.stringify(job), Date.parse(job.createdAt), job.id, TTL, prefix]);
            if (!raw) throw new ConflictError('A Studio job already uses this upload batch ID.');
            return normalize(JSON.parse(raw) as ClipJob);
        },
        async get(user: string, id: string) {
            const job = await db().get<ClipJob>(`${clippingKey(user)}:job:${id}`);
            if (!job) throw new NotFoundError('Clipping job not found.');
            return normalize(job);
        },
        async list(user: string) {
            const p = clippingKey(user);
            const ids = await db().zrange<string[]>(`${p}:jobs`, 0, 29, { rev: true });
            if (!ids.length) return [];
            return (await db().mget<Array<ClipJob | null>>(...ids.map(id => `${p}:job:${id}`))).filter((job): job is ClipJob => !!job).map(normalize);
        },
        async claim(user: string, device: string) {
            const p = clippingKey(user); const lease = crypto.randomUUID(); const now = Date.now();
            const result = await db().eval<unknown[], string | ClipJob | null>(`local active=redis.call('GET',KEYS[2]); if active then local raw=redis.call('GET',ARGV[1]..':job:'..active); if raw then local j=cjson.decode(raw); if j.status=='processing' and j.deviceId==ARGV[2] and j.leaseExpires>tonumber(ARGV[4]) then return raw end; if j.status=='processing' then j.status='failed'; j.error='The Mac processor stopped responding. Retry this job.'; j.stage='Processor disconnected'; redis.call('SET',ARGV[1]..':job:'..active,cjson.encode(j),'EX',ARGV[6]) end end; redis.call('DEL',KEYS[2]) end
for i=1,5 do
local popped=redis.call('ZPOPMIN',KEYS[1]); if #popped==0 then return nil end
local key=ARGV[1]..':job:'..popped[1]; local raw=redis.call('GET',key)
if raw then local job=cjson.decode(raw); if job.status=='queued' then
job.status='processing'; job.stage='Starting on your Mac'; job.deviceId=ARGV[2]; job.leaseId=ARGV[3]; job.leaseExpires=tonumber(ARGV[4])+300000; job.updatedAt=ARGV[5]
local value=cjson.encode(job); redis.call('SET',key,value,'EX',ARGV[6]); redis.call('SET',KEYS[2],job.id,'EX',ARGV[6]); return value end end end return nil`, [`${p}:queue`, `${p}:active:${device}`], [p, device, lease, now, new Date(now).toISOString(), TTL]);
            return result ? normalize(typeof result === 'string' ? JSON.parse(result) as ClipJob : result as ClipJob) : null;
        },
        async progress(user: string, id: string, lease: string, device: string, patch: Partial<ClipJob>) {
            const p = clippingKey(user);
            const result = await db().eval<unknown[], number>(`local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end
local j=cjson.decode(raw); if j.status~='processing' or j.leaseId~=ARGV[1] or j.deviceId~=ARGV[2] or j.leaseExpires<tonumber(ARGV[4]) then return 0 end
local patch=cjson.decode(ARGV[3]); for k,v in pairs(patch) do j[k]=v end
j.leaseExpires=tonumber(ARGV[4])+300000; j.updatedAt=ARGV[5]
redis.call('SET',KEYS[1],cjson.encode(j),'EX',ARGV[6]); return 1`, [`${p}:job:${id}`], [lease, device, JSON.stringify(patch), Date.now(), new Date().toISOString(), TTL]);
            if (!result) throw new ConflictError('This job was cancelled or its processor lease expired.');
        },
        async cancel(user: string, id: string) {
            const p = clippingKey(user);
            const result = await db().eval<unknown[], number>(`local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end
local j=cjson.decode(raw); if j.status=='completed' or j.status=='cancelled' then return 1 end
j.status='cancelled'; j.stage='Cancelled'; j.updatedAt=ARGV[2]; redis.call('SET',KEYS[1],cjson.encode(j),'EX',ARGV[3]); redis.call('ZREM',KEYS[2],ARGV[1]); return 1`, [`${p}:job:${id}`, `${p}:queue`], [id, new Date().toISOString(), TTL]);
            if (!result) throw new NotFoundError('Clipping job not found.');
        },
        async retry(user: string, id: string) {
            const p = clippingKey(user);
            const result = await db().eval<unknown[], number>(`local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end
local j=cjson.decode(raw); if j.status=='queued' or j.status=='completed' or (j.status=='processing' and j.leaseExpires>tonumber(ARGV[2])) then return -1 end
j.status='queued'; j.progress=0; j.stage='Waiting for your Mac'; j.error=nil; j.leaseId=nil; j.deviceId=nil; j.clips={}; j.updatedAt=ARGV[3]
redis.call('SET',KEYS[1],cjson.encode(j),'EX',ARGV[4]); redis.call('ZADD',KEYS[2],ARGV[2],ARGV[1]); return 1`, [`${p}:job:${id}`, `${p}:queue`], [id, Date.now(), new Date().toISOString(), TTL]);
            if (result !== 1) throw new ConflictError('This job cannot be retried while it is active or completed.');
        },
        async enqueueCaption(user: string, task: CaptionTask, deviceId: string, data: Record<string, unknown>) {
            const p = clippingKey(user), queue = captionQueueKey(user, deviceId);
            const value = { ...task, deviceId, leaseId: '', leaseExpires: 0, ...data };
            const ok = await db().eval<unknown[], number>(`if redis.call('EXISTS',KEYS[1])==1 then return 0 end
redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[4]); redis.call('ZADD',KEYS[2],ARGV[2],ARGV[3]); redis.call('EXPIRE',KEYS[2],ARGV[4]); return 1`, [captionTaskKey(user, task.id), queue], [JSON.stringify(value), Date.now(), task.id, CAPTION_TTL]);
            if (!ok) throw new ConflictError('This caption task already exists.');
            return task;
        },
        async claimCaption(user: string, deviceId: string) {
            const queue = captionQueueKey(user, deviceId), lease = crypto.randomUUID(), now = Date.now();
            const raw = await db().eval<unknown[], string | null>(`local rows=redis.call('ZRANGEBYSCORE',KEYS[1],'-inf',ARGV[1],'LIMIT',0,1); if #rows==0 then return nil end
local id=rows[1]; local key=ARGV[2]..':caption-task:'..id; local raw=redis.call('GET',key); if not raw then redis.call('ZREM',KEYS[1],id); return nil end
local t=cjson.decode(raw); if t.status=='completed' or t.status=='failed' then redis.call('ZREM',KEYS[1],id); return nil end
t.status='processing'; t.stage= t.kind=='inspect' and 'Reading timed captions on your Mac' or 'Rendering corrected captions on your Mac'; t.leaseId=ARGV[3]; t.leaseExpires=tonumber(ARGV[1])+300000; t.updatedAt=ARGV[4]; raw=cjson.encode(t); redis.call('SET',key,raw,'EX',ARGV[5]); redis.call('ZADD',KEYS[1],t.leaseExpires,id); return raw`, [queue], [now, clippingKey(user), lease, new Date(now).toISOString(), CAPTION_TTL]);
            return raw ? JSON.parse(raw) as Record<string, unknown> : null;
        },
        async getCaption(user: string, taskId: string) {
            const value = await db().get<Record<string, unknown>>(captionTaskKey(user, taskId));
            if (!value) throw new NotFoundError('Caption edit task not found.');
            return value;
        },
        async captionProgress(user: string, taskId: string, deviceId: string, lease: string, patch: Record<string, unknown>) {
            const taskKey = captionTaskKey(user, taskId);
            const result = await db().eval<unknown[], number>(`local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end
local t=cjson.decode(raw); if t.deviceId~=ARGV[1] or t.leaseId~=ARGV[2] or t.leaseExpires<tonumber(ARGV[4]) or (t.status~='processing' and t.status~='queued') then return 0 end
local patch=cjson.decode(ARGV[3]); for k,v in pairs(patch) do t[k]=v end; t.updatedAt=ARGV[5]
if t.status=='completed' or t.status=='failed' then redis.call('ZREM',KEYS[2],ARGV[6]); t.leaseExpires=0; t.leaseId='' else t.status='processing'; t.leaseExpires=tonumber(ARGV[4])+300000; redis.call('ZADD',KEYS[2],t.leaseExpires,ARGV[6]) end
redis.call('SET',KEYS[1],cjson.encode(t),'EX',ARGV[7]); return 1`, [taskKey, captionQueueKey(user, deviceId)], [deviceId, lease, JSON.stringify(patch), Date.now(), new Date().toISOString(), taskId, CAPTION_TTL]);
            if (!result) throw new ConflictError('The caption task was cancelled or its Mac lease expired.');
        },
        async completeCaptionRevision(user: string, taskId: string, deviceId: string, lease: string, expectedKey: string, clipPatch: { key: string; url: string; captionWords: Array<{ text: string; start: number; end: number }> }) {
            const p = clippingKey(user), taskKey = captionTaskKey(user, taskId);
            const result = await db().eval<unknown[], number>(`local raw=redis.call('GET',KEYS[1]); if not raw then return -1 end
local t=cjson.decode(raw); if t.deviceId~=ARGV[1] or t.leaseId~=ARGV[2] or t.leaseExpires<tonumber(ARGV[5]) or t.status~='processing' or t.kind~='render' then return -2 end
local jk=ARGV[3]..':job:'..t.jobId; local jr=redis.call('GET',jk); if not jr then return -3 end; local j=cjson.decode(jr); local found=false
for _,clip in ipairs(j.clips or {}) do if clip.id==t.clipId then if clip.key~=ARGV[4] then return -4 end; clip.key=ARGV[6]; clip.url=ARGV[7]; clip.captionWords=cjson.decode(ARGV[8]); found=true; break end end
if not found then return -3 end; j.updatedAt=ARGV[9]; redis.call('SET',jk,cjson.encode(j),'EX',ARGV[10]); t.status='completed'; t.stage='Captions updated'; t.updatedAt=ARGV[9]; t.leaseId=''; t.leaseExpires=0; redis.call('SET',KEYS[1],cjson.encode(t),'EX',ARGV[10]); redis.call('ZREM',KEYS[2],t.id); return 1`, [taskKey, captionQueueKey(user, deviceId)], [deviceId, lease, p, expectedKey, Date.now(), clipPatch.key, clipPatch.url, JSON.stringify(clipPatch.captionWords), new Date().toISOString(), CAPTION_TTL]);
            if (result !== 1) throw new ConflictError(result === -4 ? 'This clip changed while the captions were rendering. Reload and try again.' : 'The caption task lease expired or its source clip is unavailable.');
        },
    };
}
