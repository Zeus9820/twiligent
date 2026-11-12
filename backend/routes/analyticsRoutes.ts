import { instagramMediaCapabilities, manageInstagramComments, deleteInstagramMedia } from '../controllers/publishingController.ts';
import { Hono } from 'hono';
import {
    getChannelAnalytics, getChannelVideos, getComparison, getVideoLibrary, getInstagramAnalytics, getInstagramMedia,
} from '../controllers/analyticsController.ts';
import type { AppEnv } from '../types/app.ts';
import { listManagedVideos, editManagedVideo, deleteManagedVideo, getYouTubeStudioUrl, getYouTubeStudioSummary, startYouTubeShortUpload } from '../controllers/youtubeStudioController.ts';

const router = new Hono<AppEnv>();
router.get('/accounts/:id/ig-management', ...instagramMediaCapabilities);
router.put('/accounts/:id/ig-media/:mediaId/comments', ...manageInstagramComments);
router.delete('/accounts/:id/ig-media/:mediaId', ...deleteInstagramMedia);
router.get('/accounts/:id/youtube-studio/videos', ...listManagedVideos);
router.put('/accounts/:id/youtube-studio/videos/:videoId', ...editManagedVideo);
router.delete('/accounts/:id/youtube-studio/videos/:videoId', ...deleteManagedVideo);

router.get('/accounts/:id/analytics', ...getChannelAnalytics);
router.get('/accounts/:id/youtube-studio/connect', ...getYouTubeStudioUrl);
router.get('/accounts/:id/youtube-studio', ...getYouTubeStudioSummary);
router.post('/accounts/:id/youtube-studio/short-uploads', ...startYouTubeShortUpload);
router.get('/accounts/:id/videos', ...getChannelVideos);
router.get('/comparison', ...getComparison);
router.get('/videos/all', ...getVideoLibrary);
router.get('/accounts/:id/ig-analytics', ...getInstagramAnalytics);
router.get('/accounts/:id/ig-media', ...getInstagramMedia);

export default router;
