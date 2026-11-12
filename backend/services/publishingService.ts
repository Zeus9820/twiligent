import {
    buildMediaParams, createMediaContainer, fetchContainerStatus, publishMediaContainer, fetchPublishingLimit,
} from './instagram/instagramPublishing.ts';
import { NotConfiguredError, NotFoundError, ValidationError } from '../lib/errors.ts';
import { publishWindsorPost } from './instagram/windsorInstagram.ts';
import type { Redis } from '../types/app.ts';
import type { ContainerStatus } from './instagram/instagramPublishing.ts';
import type { AccountRepository } from '../repositories/accountRepository.ts';
import type { AppConfig } from '../lib/config.ts';
import type { RequestContext } from '../types/context.ts';
import type { Account } from '../../shared/types/domain.ts';
import type { InstagramPublishingLimit, InstagramPublishRequest } from '../../shared/types/instagram.ts';

export interface PublishingDeps {
    accounts: AccountRepository;
    config: AppConfig;
    context: RequestContext;
    redis?: Redis | null;
}

export interface PublishingService {
    publishingLimit(userId: string, accountId: string): Promise<InstagramPublishingLimit[]>;
    createContainer(userId: string, accountId: string, post: InstagramPublishRequest): Promise<string>;
    containerStatus(userId: string, accountId: string, containerId: string): Promise<ContainerStatus>;
    publishContainer(userId: string, accountId: string, containerId: string): Promise<string>;
}

export type PublishableAccount = Account & { igUserId: string; accessToken: string };

export const NO_INSTAGRAM_TOKEN_MESSAGE = 'No Instagram access token stored - reconnect this account';

// the only accounts that can publish: Instagram, with the id and token the Graph API calls need
export function publishableAccount(account: Account | null): PublishableAccount {
    if (!account || account.platform !== 'instagram') throw new NotFoundError('Instagram account not found');
    if (account.instagramProvider === 'windsor') throw new ValidationError('Scheduled publishing is not available for Windsor accounts yet.');
    if (!account.accessToken || !account.igUserId) throw new ValidationError(NO_INSTAGRAM_TOKEN_MESSAGE);
    return { ...account, igUserId: account.igUserId, accessToken: account.accessToken };
}

export function createPublishingService({ accounts, config, context, redis }: PublishingDeps): PublishingService {
    const { signal } = context;

    async function findPublishable(userId: string, accountId: string): Promise<PublishableAccount> {
        return publishableAccount(await accounts.findForUser(accountId, userId));
    }

    async function windsorAccount(userId: string, accountId: string): Promise<Account | null> {
        const account = await accounts.findForUser(accountId, userId);
        if (account?.instagramProvider !== 'windsor') return null;
        if (!config.windsor || config.windsor.ownerUserId !== userId || !account.igUserId) throw new ValidationError('Windsor is not configured for this account');
        return account;
    }

    function store(): Redis {
        if (!redis) throw new NotConfiguredError('Publishing through Windsor requires the publishing store to be configured.');
        return redis;
    }

    function stageKey(userId: string, accountId: string, containerId: string): string {
        if (!/^windsor-[0-9a-f-]{36}$/.test(containerId)) throw new ValidationError('Invalid Windsor publishing request');
        return `windsor:publish:${userId}:${accountId}:${containerId}`;
    }

    return {
        async publishingLimit(userId, accountId) {
            if (await windsorAccount(userId, accountId)) return [];
            const account = await findPublishable(userId, accountId);
            return fetchPublishingLimit(account.igUserId, account.accessToken, signal);
        },

        async createContainer(userId, accountId, post) {
            if (await windsorAccount(userId, accountId)) {
                const containerId = `windsor-${crypto.randomUUID()}`;
                await store().set(stageKey(userId, accountId, containerId), post, { ex: 3600 });
                return containerId;
            }
            const account = await findPublishable(userId, accountId);
            return createMediaContainer(account.igUserId, buildMediaParams(post, account.accessToken), signal);
        },

        async containerStatus(userId, accountId, containerId) {
            if (await windsorAccount(userId, accountId)) {
                const post = await store().get(stageKey(userId, accountId, containerId));
                if (!post) return { statusCode: 'EXPIRED', status: 'Publishing request expired' };
                return { statusCode: 'FINISHED', status: 'Ready to publish' };
            }
            const account = await findPublishable(userId, accountId);
            return fetchContainerStatus(containerId, account.accessToken, signal);
        },

        async publishContainer(userId, accountId, containerId) {
            const windsor = await windsorAccount(userId, accountId);
            if (windsor && config.windsor && windsor.igUserId) {
                const redisClient = store();
                const key = stageKey(userId, accountId, containerId);
                const post = await redisClient.get<InstagramPublishRequest>(key);
                if (!post) throw new ValidationError('Publishing request expired; start again.');
                const claim = await redisClient.set(`${key}:claimed`, '1', { nx: true, ex: 604800 });
                if (!claim) throw new ValidationError('This publishing request has already been sent. Check Instagram before trying again.');
                const result = await publishWindsorPost(config.windsor.apiKey, windsor.igUserId, post, signal);
                if (result && typeof result === 'object' && !Array.isArray(result)) {
                    const object = result as Record<string, unknown>;
                    const nested = object.data && typeof object.data === 'object' ? object.data as Record<string, unknown> : {};
                    const mediaId = object.media_id ?? object.id ?? nested.media_id ?? nested.id;
                    if (typeof mediaId === 'string' && mediaId) return mediaId;
                }
                throw new ValidationError('Windsor did not return a media ID. Check Instagram before trying again.');
            }
            const account = await findPublishable(userId, accountId);
            return publishMediaContainer(account.igUserId, containerId, account.accessToken, signal);
        },
    };
}
