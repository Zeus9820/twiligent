import { controller, pathParam } from './http.ts';
import { NotConfiguredError, ValidationError } from '../lib/errors.ts';
import type { AppContext } from '../types/app.ts';
import type { MediaStorageConfigResponse } from '../../shared/types/instagram.ts';

const PART_SIZE = 8 * 1024 * 1024;
const MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime']);

function bucket(c: AppContext): R2Bucket {
    if (!c.env.MEDIA_BUCKET || !c.env.MEDIA_PUBLIC_URL) {
        throw new NotConfiguredError('R2 media storage is not configured.');
    }
    return c.env.MEDIA_BUCKET;
}

function objectKey(c: AppContext, value: unknown): string {
    if (typeof value !== 'string' || !value.startsWith(`${c.get('userId')}/`)) {
        throw new ValidationError('Invalid media upload key.');
    }
    return value;
}

function publicUrl(c: AppContext, key: string): string {
    const base = c.env.MEDIA_PUBLIC_URL!.replace(/\/+$/, '');
    return `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

export const getMediaUploadConfig = controller.createHandlers(c => {
    const configured = Boolean(c.env.MEDIA_BUCKET && c.env.MEDIA_PUBLIC_URL);
    return c.json({ success: true, configured } satisfies MediaStorageConfigResponse);
});

export const startMediaUpload = controller.createHandlers(async c => {
    const body = await c.req.json().catch(() => null) as { contentType?: unknown; fileName?: unknown } | null;
    if (!body || typeof body.contentType !== 'string' || !MEDIA_TYPES.has(body.contentType)) {
        throw new ValidationError('Choose a supported JPEG, MP4 or MOV file.');
    }
    const extension = typeof body.fileName === 'string' ? body.fileName.split('.').pop()?.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() : '';
    const key = `${c.get('userId')}/${crypto.randomUUID()}.${extension || 'bin'}`;
    const upload = await bucket(c).createMultipartUpload(key, { httpMetadata: { contentType: body.contentType } });
    return c.json({ success: true, key, uploadId: upload.uploadId, partSize: PART_SIZE, publicUrl: publicUrl(c, key) });
});

export const uploadMediaPart = controller.createHandlers(async c => {
    const key = objectKey(c, c.req.query('key'));
    const partNumber = Number(pathParam(c, 'partNumber'));
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) throw new ValidationError('Invalid multipart part number.');
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > 16 * 1024 * 1024) throw new ValidationError('Invalid multipart part size.');
    const upload = bucket(c).resumeMultipartUpload(key, pathParam(c, 'uploadId'));
    const part = await upload.uploadPart(partNumber, bytes);
    return c.json({ success: true, partNumber: part.partNumber, etag: part.etag });
});

export const completeMediaUpload = controller.createHandlers(async c => {
    const body = await c.req.json().catch(() => null) as { key?: unknown; parts?: unknown } | null;
    const key = objectKey(c, body?.key);
    if (!Array.isArray(body?.parts) || body.parts.length === 0 || body.parts.length > 10_000) {
        throw new ValidationError('Invalid multipart completion request.');
    }
    const parts = body.parts.map(part => {
        if (!part || typeof part !== 'object') throw new ValidationError('Invalid multipart part.');
        const candidate = part as { partNumber?: unknown; etag?: unknown };
        if (!Number.isInteger(candidate.partNumber) || Number(candidate.partNumber) < 1 || typeof candidate.etag !== 'string') {
            throw new ValidationError('Invalid multipart part.');
        }
        return { partNumber: Number(candidate.partNumber), etag: candidate.etag };
    }).sort((a, b) => a.partNumber - b.partNumber);
    const storage = bucket(c);
    if (!await storage.head(key)) await storage.resumeMultipartUpload(key, pathParam(c, 'uploadId')).complete(parts);
    return c.json({ success: true, publicUrl: publicUrl(c, key) });
});

export const abortMediaUpload = controller.createHandlers(async c => {
    const body = await c.req.json().catch(() => null) as { key?: unknown } | null;
    const key = objectKey(c, body?.key);
    await bucket(c).resumeMultipartUpload(key, pathParam(c, 'uploadId')).abort();
    return c.json({ success: true });
});
