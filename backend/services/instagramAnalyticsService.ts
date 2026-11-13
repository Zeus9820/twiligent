import { fetchAccountViews } from './instagram/accountViews.ts';
import { fetchInstagramProfile } from './instagram/instagramApi.ts';
import { fetchInstagramMedia } from './instagram/instagramMedia.ts';
import { computeInstagramAnalytics } from './instagram/instagramAnalytics.ts';
import { NotFoundError, ValidationError } from '../lib/errors.ts';
import { safeAccount } from '../lib/safeAccount.ts';
import { fetchWindsorProfile, fetchWindsorMedia } from './instagram/windsorInstagram.ts';
import type { AppConfig } from '../lib/config.ts';
import type { AccountRepository } from '../repositories/accountRepository.ts';
import type { AnalyticsCacheRepository } from '../repositories/analyticsCacheRepository.ts';
import type { RequestContext } from '../types/context.ts';
import type { Account, SafeAccount } from '../../shared/types/domain.ts';
import type { InstagramAnalytics, InstagramMedia, InstagramProfile } from '../../shared/types/instagram.ts';

export interface InstagramAnalyticsDeps {
    accounts: AccountRepository;
    cache: AnalyticsCacheRepository;
    context: RequestContext;
    config?: AppConfig;
}

export interface InstagramAccountAnalytics {
    profile: InstagramProfile;
    account: SafeAccount;
    analytics: InstagramAnalytics;
    mediaCount: number;
}

export interface InstagramMediaList {
    media: InstagramMedia[];
    fetchedAt: string;
}

export interface InstagramAnalyticsService {
    accountViews(userId: string, accountId: string, start: string, end: string): ReturnType<typeof fetchAccountViews>;
    analytics(userId: string, accountId: string): Promise<InstagramAccountAnalytics>;
    media(userId: string, accountId: string, fresh?: boolean): Promise<InstagramMediaList>;
}

type ConnectedInstagramAccount = Account & { igUserId: string; accessToken: string };

const MEDIA_LIMIT = 500;

export function createInstagramAnalyticsService({ accounts, cache, context, config }: InstagramAnalyticsDeps): InstagramAnalyticsService {
    const { signal } = context;

    async function findConnected(userId: string, accountId: string): Promise<ConnectedInstagramAccount> {
        const account = await accounts.findForUser(accountId, userId);
        if (!account || account.platform !== 'instagram') throw new NotFoundError('Instagram account not found');
        if (!account.igUserId || (!account.accessToken && account.instagramProvider !== 'windsor')) throw new ValidationError('No access token stored - reconnect this Instagram account');
        if (account.instagramProvider === 'windsor' && (!config?.windsor || config.windsor.ownerUserId !== userId)) throw new ValidationError('Windsor is not configured for this account');
        return { ...account, igUserId: account.igUserId, accessToken: account.accessToken || '' };
    }

    return {
        async accountViews(userId, accountId, start, end) {
            const account = await findConnected(userId, accountId);
            if (account.instagramProvider === 'windsor') throw new ValidationError('Account views require a direct Meta connection.');
            return fetchAccountViews(account.igUserId, account.accessToken, start, end, signal);
        },
        // always live: the media is cached and the profile counts are saved for the Overview
        async analytics(userId, accountId) {
            const account = await findConnected(userId, accountId);
            const [profile, media] = account.instagramProvider === 'windsor' && config?.windsor
                ? await Promise.all([fetchWindsorProfile(config.windsor.apiKey, account.igUserId, signal), fetchWindsorMedia(config.windsor.apiKey, account.igUserId, signal)])
                : await Promise.all([fetchInstagramProfile(account.igUserId, account.accessToken, signal), fetchInstagramMedia(account.igUserId, account.accessToken, MEDIA_LIMIT, signal)]);
            await Promise.all([
                cache.setInstagramMedia(userId, accountId, { media, fetchedAt: new Date().toISOString() }),
                accounts.updateForUser(account.id, {
                    followersCount: profile.followersCount,
                    followsCount: profile.followsCount,
                    mediaCount: profile.mediaCount,
                    profilePictureUrl: profile.profilePictureUrl,
                    lastUpdated: new Date().toISOString(),
                }, userId),
            ]);
            const analytics = computeInstagramAnalytics(profile, media);
            analytics.topReelsByViews = media.filter(item => item.contentType === 'reel' && item.viewCount !== null)
                .sort((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0)).slice(0, 10)
                .map(item => ({ ...item, engagement: item.likeCount + item.commentsCount }));
            return { profile, account: safeAccount(account), analytics, mediaCount: media.length };
        },

        async media(userId, accountId, fresh = false) {
            const cached = fresh ? null : await cache.getInstagramMedia(userId, accountId);
            if (cached?.media && Date.now() - Date.parse(cached.fetchedAt) < 300_000) return { media: cached.media, fetchedAt: cached.fetchedAt };
            const account = await findConnected(userId, accountId);
            const media = account.instagramProvider === 'windsor' && config?.windsor
                ? await fetchWindsorMedia(config.windsor.apiKey, account.igUserId, signal)
                : await fetchInstagramMedia(account.igUserId, account.accessToken, MEDIA_LIMIT, signal);
            const fetchedAt = new Date().toISOString();
            await cache.setInstagramMedia(userId, accountId, { media, fetchedAt });
            return { media, fetchedAt };
        },
    };
}
