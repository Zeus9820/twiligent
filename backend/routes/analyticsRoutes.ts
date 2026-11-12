import { Hono } from 'hono';
import {
    getChannelAnalytics, getChannelVideos, getComparison, getVideoLibrary, getInstagramAnalytics, getInstagramMedia,
} from '../controllers/analyticsController.ts';
import type { AppEnv } from '../types/app.ts';
import { getYouTubeStudioUrl, getYouTubeStudioSummary, startYouTubeShortUpload } from '../controllers/youtubeStudioController.ts';

const router = new Hono<AppEnv>();

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
