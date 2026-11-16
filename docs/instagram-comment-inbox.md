# Instagram comment inbox

The browser reads 25 comments at a time from the backend. Opening the page does not fan out to every Reel. The default Needs reply filter excludes comments with a confirmed creator reply and the creator's own top-level comments. Unread means not opened in Studio; it does not represent Instagram's native read state.

## Storage and pagination

The existing Upstash Redis connection stores comment content for seven days. Separate account/user-scoped status hashes retain read timestamps, confirmed reply timestamps and reply text without a content-cache TTL. Resync never clears those statuses. Four sorted indexes serve All, Needs reply, Unread and Replied. A timestamp plus comment ID provides a stable, exclusive pagination cursor even when comments share timestamps. Page reads and imports use Redis pipelines; status/index changes use Lua atomically. Expired payloads are removed from indexes lazily.

This relies on the configured Redis database's availability and persistence. Inbox operations fail visibly if storage is unavailable; the browser does not fall back to loading every Reel. There is no new SQL migration.

## Synchronization

A sync request reads at most one media discovery page (10 posts) and two comment/reply pages (25 top-level comments each). Media with no comments is skipped. Replies are expanded to identify the creator by ID or username. Large reply threads retain their cursor and are classified only after the creator is found or all replies have been checked. A 90-second account lease prevents overlapping syncs. Progress is saved only after successful idempotent imports.

Latest sync and older-history import have separate progress. Opening the inbox performs one bounded latest sync, throttled to once a minute per account. The Import next batch button advances history explicitly. Historical completeness is not implied until those batches finish. Replies made directly on Instagram appear after their thread is synced.

Confirmed sends persist reply status before returning. A per-comment lease, saved-status check and live reply check guard against duplicate sends. Ambiguous sends are never automatically retried. AI generation uses the selected comment's latest text and never posts automatically.

## Verification

`backend/tests/services/instagramInboxService.test.ts` verifies the request budget, continuation, external creator-reply detection and ownership checks. Existing comments, messaging and automation-review tests also pass. A temporary Redis namespace was used to verify actual Lua/index behavior, cursor ties, status retention, tenant isolation and locks, then deleted. A live Instagram read checked the fields and first sync without sending any replies.
