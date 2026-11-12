import { Hono } from 'hono';
import {
    getPublishingLimit, createContainer, getContainerStatus, publishContainer,
} from '../controllers/publishingController.ts';
import { abortMediaUpload, completeMediaUpload, getMediaUploadConfig, startMediaUpload, uploadMediaPart } from '../controllers/mediaUploadController.ts';
import type { AppEnv } from '../types/app.ts';

const router = new Hono<AppEnv>();

router.get('/media-storage-config', ...getMediaUploadConfig);
router.post('/media-uploads', ...startMediaUpload);
router.put('/media-uploads/:uploadId/parts/:partNumber', ...uploadMediaPart);
router.post('/media-uploads/:uploadId/complete', ...completeMediaUpload);
router.delete('/media-uploads/:uploadId', ...abortMediaUpload);
router.get('/accounts/:id/ig-publishing-limit', ...getPublishingLimit);
router.post('/accounts/:id/ig-publish', ...createContainer);
router.get('/ig-container/:containerId/status', ...getContainerStatus);
router.post('/accounts/:id/ig-media-publish', ...publishContainer);

export default router;
