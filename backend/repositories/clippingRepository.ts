import { ConflictError, NotConfiguredError, NotFoundError } from '../lib/errors.ts';
import type { Redis } from '../types/app.ts';
import type { ClipJob } from '../../shared/types/clipping.ts';
const TTL = 30 * 86400;
function normalize(job: ClipJob): ClipJob { return { ...job, clips: Array.isArray(job.clips) ? job.clips : [] }; }
export const clippingKey = (user: string) => `clipping:v1:${user}`;
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
    };
}
