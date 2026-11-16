import { Hono } from 'hono';
import { getInstagramAuthUrl } from '../controllers/instagramAuthController.ts';
import { getFacebookPageAuthUrl } from '../controllers/facebookPageController.ts';
import type { AppEnv } from '../types/app.ts';

const router = new Hono<AppEnv>();

router.get('/auth/instagram/url', ...getInstagramAuthUrl);
router.get('/accounts/:id/facebook-page/url', ...getFacebookPageAuthUrl);

export default router;
