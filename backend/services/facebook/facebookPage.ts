import { createOAuthState, verifyOAuthState } from '../../lib/oauthState.ts';
import { NotConfiguredError, NotFoundError, UpstreamError, ValidationError } from '../../lib/errors.ts';
import { encryptFacebookPageToken } from '../../lib/facebookPageToken.ts';
import type { AccountRepository } from '../../repositories/accountRepository.ts';
import type { AuditRepository } from '../../repositories/auditRepository.ts';
import type { AppConfig } from '../../lib/config.ts';
import type { RequestContext } from '../../types/context.ts';
import type { Account } from '../../../shared/types/domain.ts';

const GRAPH = 'https://graph.facebook.com/v26.0';
const CONFIG_ERROR = 'Facebook Page connection is missing its Meta app credentials, Login for Business configuration, or token encryption key.';

interface GraphError { error?: { message?: string } }
interface AccessTokenResponse extends GraphError { access_token?: string; expires_in?: number }
interface PageListResponse extends GraphError { data?: Array<{ id: string; name: string; access_token: string }> }

export interface FacebookPageService {
    readonly configured: boolean;
    readonly accountsPageUrl: string;
    authorizationUrl(userId: string, accountId: string): Promise<string>;
    connect(state: string, code: string): Promise<void>;
}

export function createFacebookPageService({ accounts, audit, config, context }: {
    accounts: AccountRepository; audit: AuditRepository; config: AppConfig; context: RequestContext;
}): FacebookPageService {
    const settings = config.facebook;
    const { signal } = context;
    const isConfigured = Boolean(settings.appId && settings.appSecret && settings.tokenKey);

    function configuredSettings() {
        if (!settings.appId || !settings.appSecret || !settings.tokenKey) throw new NotConfiguredError(CONFIG_ERROR);
        return { ...settings, appId: settings.appId, appSecret: settings.appSecret, tokenKey: settings.tokenKey };
    }

    async function graph<T extends GraphError>(path: string, params: Record<string, string>): Promise<T> {
        const url = new URL(`${GRAPH}${path}`);
        url.search = new URLSearchParams(params).toString();
        let response: Response;
        try { response = await fetch(url, { signal }); }
        catch (err) { throw new UpstreamError(`Facebook API unreachable (${(err as Error).message})`, { cause: err }); }
        const body = await response.json() as T;
        if (!response.ok || body.error) throw new UpstreamError(body.error?.message || `Facebook API returned HTTP ${response.status}`);
        return body;
    }

    return {
        configured: isConfigured,
        accountsPageUrl: `${settings.frontendUrl}/accounts`,

        async authorizationUrl(userId, accountId) {
            const oauth = configuredSettings();
            const account = await accounts.findForUser(accountId, userId);
            if (!account || account.platform !== 'instagram' || !account.igUserId) throw new NotFoundError('Instagram account not found.');
            const state = await createOAuthState(`${userId}|${accountId}`, oauth.appSecret);
            const params = new URLSearchParams({
                client_id: oauth.appId,
                redirect_uri: oauth.redirectUri,
                response_type: 'code',
                // Meta's /me/accounts edge requires pages_manage_metadata in
                // addition to pages_show_list; without it the grant can look
                // successful while returning an empty Page list.
                scope: 'pages_show_list,pages_manage_metadata,pages_manage_posts',
                state,
            });
            return `https://www.facebook.com/dialog/oauth?${params}`;
        },

        async connect(state, code) {
            const oauth = configuredSettings();
            const signed = await verifyOAuthState(state, oauth.appSecret);
            const separator = signed?.lastIndexOf('|') ?? -1;
            if (!signed || separator < 1) throw new ValidationError('Facebook sign-in expired. Start connecting the Page again.');
            const userId = signed.slice(0, separator);
            const accountId = signed.slice(separator + 1);
            const account = await accounts.findForUser(accountId, userId);
            if (!account || account.platform !== 'instagram' || !account.igUserId) throw new NotFoundError('Instagram account not found.');

            const tokenResult = await graph<AccessTokenResponse>('/oauth/access_token', {
                client_id: oauth.appId,
                client_secret: oauth.appSecret,
                redirect_uri: oauth.redirectUri,
                code: code.replace(/#.*$/, ''),
            });
            if (!tokenResult.access_token) throw new UpstreamError('Facebook did not return an access token.');
            let userToken = tokenResult.access_token;
            try {
                const extended = await graph<AccessTokenResponse>('/oauth/access_token', {
                    grant_type: 'fb_exchange_token', client_id: oauth.appId, client_secret: oauth.appSecret, fb_exchange_token: userToken,
                });
                userToken = extended.access_token || userToken;
            } catch {
                // The Page token remains usable if Meta does not allow exchanging this login token.
            }

            const pages = await graph<PageListResponse>('/me/accounts', { fields: 'id,name,access_token', access_token: userToken });
            const available = pages.data ?? [];
            const normalized = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
            const exact = available.filter(page => normalized(page.name) === 'gameofkratos');
            const page = exact.length === 1 ? exact[0] : exact.length === 0 && available.length === 1 ? available[0] : null;
            if (!page) throw new ValidationError(available.length ? 'Select a single Game of Kratos Facebook Page in Meta, then connect again.' : 'No Facebook Pages were granted to Kratos Studio. Grant access to the Game of Kratos Page and try again.');
            if (!page.access_token) throw new UpstreamError('Facebook did not return a Page access token.');

            const updates: Partial<Account> = {
                facebookPageId: page.id,
                facebookPageName: page.name,
                encryptedFacebookPageAccessToken: await encryptFacebookPageToken(page.access_token, oauth.tokenKey, userId, account.id),
            };
            await accounts.updateForUser(account.id, updates, userId);
            await audit.recordForUser(userId, { action: 'account.facebook_page_connected', subjectType: 'account', subjectId: account.id, details: { pageId: page.id, pageName: page.name } });
        },
    };
}
