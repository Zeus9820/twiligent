-- creates the accounts table as it was before migrations, and is safe to run again on a database that has it
create table if not exists public.accounts (
    id text primary key,
    user_id uuid not null references auth.users (id) on delete cascade,
    platform text not null,
    data jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

-- older setup SQL had no created_at and allowed null data
alter table public.accounts add column if not exists created_at timestamptz not null default now();
update public.accounts set data = '{}'::jsonb where data is null;
alter table public.accounts alter column data set default '{}'::jsonb, alter column data set not null;

alter table public.accounts enable row level security;
-- creates the settings table as it was before migrations, and is safe to run again on a database that has it
create table if not exists public.settings (
    user_id uuid not null references auth.users (id) on delete cascade,
    key text not null,
    value jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    primary key (user_id, key)
);

-- older setup SQL had no created_at and allowed a null value
alter table public.settings add column if not exists created_at timestamptz not null default now();
update public.settings set value = '{}'::jsonb where value is null;
alter table public.settings alter column value set default '{}'::jsonb, alter column value set not null;

alter table public.settings enable row level security;
-- creates the scheduled_posts table as it was before migrations, and is safe to run again on a database that has it
create table if not exists public.scheduled_posts (
    id text primary key,
    user_id uuid not null references auth.users (id) on delete cascade,
    account_id text not null,
    status text not null default 'pending',
    scheduled_at timestamptz not null,
    data jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    claimed_at timestamptz,
    attempts integer not null default 0
);

-- older setup SQL had no created_at, no claim columns and allowed null data
alter table public.scheduled_posts
    add column if not exists created_at timestamptz not null default now(),
    add column if not exists claimed_at timestamptz,
    add column if not exists attempts integer not null default 0;
update public.scheduled_posts set data = '{}'::jsonb where data is null;
alter table public.scheduled_posts alter column data set default '{}'::jsonb, alter column data set not null;

-- posts stuck in publishing before the claim lease have no saved container, so nothing can tell whether they went out
update public.scheduled_posts
set status = 'failed',
    data = data || jsonb_build_object('error', 'Publishing was interrupted before Twiligent tracked it. Check Instagram before scheduling this post again.')
where status = 'publishing' and claimed_at is null;

create index if not exists scheduled_posts_user_id_idx on public.scheduled_posts (user_id);
create index if not exists scheduled_posts_due_idx on public.scheduled_posts (status, scheduled_at);

alter table public.scheduled_posts enable row level security;
-- creates the tracked_posts table as it was before migrations, and is safe to run again on a database that has it
create table if not exists public.tracked_posts (
    id text primary key,
    user_id uuid not null references auth.users (id) on delete cascade,
    account_id text references public.accounts (id) on delete set null,
    url text not null,
    label text not null default '',
    category text not null default '',
    content_type text not null default 'reddit',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    data jsonb
);

-- the first version of the table had no content_type
alter table public.tracked_posts add column if not exists content_type text not null default 'reddit';

create index if not exists tracked_posts_user_id_idx on public.tracked_posts (user_id);

alter table public.tracked_posts enable row level security;
-- removes all browser access to accounts, because only the Worker should read it
drop policy if exists users_own_accounts on public.accounts;
revoke all on table public.accounts from anon, authenticated;
-- removes all browser access to settings, because only the Worker should read it
drop policy if exists users_own_settings on public.settings;
revoke all on table public.settings from anon, authenticated;
-- removes all browser access to scheduled_posts, because only the Worker should read it
drop policy if exists users_own_posts on public.scheduled_posts;
revoke all on table public.scheduled_posts from anon, authenticated;
-- removes all browser access to tracked_posts, because only the Worker should read it
revoke all on table public.tracked_posts from anon, authenticated;
-- stops new tables and functions from giving the browser roles access by default
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
-- only allows known platforms and a JSON object as data on accounts
alter table public.accounts
    add constraint accounts_platform_check check (platform in ('youtube', 'instagram', 'reddit')),
    add constraint accounts_data_check check (jsonb_typeof(data) = 'object');
-- only allows a JSON object as the value of a setting
alter table public.settings
    add constraint settings_value_check check (jsonb_typeof(value) = 'object');
-- only allows the four publishing statuses, valid attempts and claims, and a JSON object as data on scheduled posts
alter table public.scheduled_posts
    add constraint scheduled_posts_status_check check (status in ('pending', 'publishing', 'published', 'failed')),
    add constraint scheduled_posts_attempts_check check (attempts >= 0),
    -- the lease is measured from the claim, so a post being published must carry one
    add constraint scheduled_posts_claim_check check (status <> 'publishing' or claimed_at is not null),
    add constraint scheduled_posts_data_check check (jsonb_typeof(data) = 'object');
-- only allows Reddit posts and YouTube videos as tracked items, an account only on Reddit items, and a JSON object or nothing as data
alter table public.tracked_posts
    add constraint tracked_posts_content_type_check check (content_type in ('reddit', 'youtube')),
    -- only Reddit items read through an account, for its cookie
    add constraint tracked_posts_account_check check (content_type = 'reddit' or account_id is null),
    add constraint tracked_posts_data_check check (data is null or jsonb_typeof(data) = 'object');
-- makes the pair of account id and owner unique, so other tables can point at an account together with its owner
alter table public.accounts add constraint accounts_id_user_id_key unique (id, user_id);
-- makes a scheduled post point at an account of the same user, and removes the post with that account
alter table public.scheduled_posts drop constraint if exists scheduled_posts_account_id_fkey;
alter table public.scheduled_posts
    add constraint scheduled_posts_account_fkey foreign key (account_id, user_id)
        references public.accounts (id, user_id) on delete cascade;
-- makes a tracked item point at an account of the same user, and clears the account when it is removed
alter table public.tracked_posts drop constraint if exists tracked_posts_account_id_fkey;
alter table public.tracked_posts
    add constraint tracked_posts_account_fkey foreign key (account_id, user_id)
        references public.accounts (id, user_id) on delete set null (account_id);
-- creates the trigger function that sets updated_at on every update
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

revoke execute on function public.set_updated_at() from public, anon, authenticated;
-- adds updated_at to accounts with the trigger that keeps updated_at current
alter table public.accounts add column if not exists updated_at timestamptz not null default now();

-- existing rows were last changed at an unknown time; their creation time is the closest honest value
update public.accounts set updated_at = created_at;

create trigger accounts_set_updated_at before update on public.accounts
    for each row execute function public.set_updated_at();
-- adds updated_at to settings with the trigger that keeps updated_at current
alter table public.settings add column if not exists updated_at timestamptz not null default now();

-- existing rows were last changed at an unknown time; their creation time is the closest honest value
update public.settings set updated_at = created_at;

create trigger settings_set_updated_at before update on public.settings
    for each row execute function public.set_updated_at();
-- adds updated_at to scheduled_posts with the trigger that keeps updated_at current
alter table public.scheduled_posts add column if not exists updated_at timestamptz not null default now();

-- existing rows were last changed at an unknown time; their creation time is the closest honest value
update public.scheduled_posts set updated_at = created_at;

create trigger scheduled_posts_set_updated_at before update on public.scheduled_posts
    for each row execute function public.set_updated_at();
-- adds the trigger that keeps updated_at current on tracked_posts, a job the code did before
create trigger tracked_posts_set_updated_at before update on public.tracked_posts
    for each row execute function public.set_updated_at();
-- creates merge_account_data, which merges changes into an account in one step so two writers never undo each other
create or replace function public.merge_account_data(p_id text, p_user_id uuid, p_patch jsonb)
returns boolean
language sql
set search_path = ''
as $$
    update public.accounts
    set data = data || p_patch
    where id = p_id and (p_user_id is null or user_id = p_user_id)
    returning true;
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.merge_account_data(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.merge_account_data(text, uuid, jsonb) to service_role;
-- creates merge_scheduled_post, which changes a scheduled post in one step and can refuse a post that is no longer pending
create or replace function public.merge_scheduled_post(
    p_id text,
    p_user_id uuid,
    p_patch jsonb,
    p_status text default null,
    p_scheduled_at timestamptz default null,
    p_only_status text default null
)
returns boolean
language sql
set search_path = ''
as $$
    update public.scheduled_posts
    set data = data || p_patch,
        status = coalesce(p_status, status),
        scheduled_at = coalesce(p_scheduled_at, scheduled_at)
    where id = p_id
        and (p_user_id is null or user_id = p_user_id)
        and (p_only_status is null or status = p_only_status)
    returning true;
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.merge_scheduled_post(text, uuid, jsonb, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.merge_scheduled_post(text, uuid, jsonb, text, timestamptz, text) to service_role;
-- creates merge_tracked_post_data, which merges changes into a tracked item in one step
create or replace function public.merge_tracked_post_data(p_id text, p_user_id uuid, p_patch jsonb)
returns boolean
language sql
set search_path = ''
as $$
    update public.tracked_posts
    set data = coalesce(data, '{}'::jsonb) || p_patch
    where id = p_id and user_id = p_user_id
    returning true;
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.merge_tracked_post_data(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.merge_tracked_post_data(text, uuid, jsonb) to service_role;
-- adds an index that lists a user's accounts in the order they were added
create index if not exists accounts_user_id_created_at_idx on public.accounts (user_id, created_at, id);
-- replaces the scheduled posts user index with one that also sorts by scheduled time
create index if not exists scheduled_posts_user_id_scheduled_at_idx on public.scheduled_posts (user_id, scheduled_at);
drop index if exists public.scheduled_posts_user_id_idx;
-- adds indexes that let the schedulers find due and stuck posts without reading published ones
drop index if exists public.scheduled_posts_due_idx;
create index scheduled_posts_due_idx on public.scheduled_posts (scheduled_at) where status = 'pending';
create index if not exists scheduled_posts_claimed_idx on public.scheduled_posts (claimed_at) where status = 'publishing';
-- replaces the tracked items user index with one that also sorts by newest first
create index if not exists tracked_posts_user_id_created_at_idx on public.tracked_posts (user_id, created_at desc);
drop index if exists public.tracked_posts_user_id_idx;
-- creates automation_accounts, which holds each Instagram account's pause, cooldowns and webhook subscription
create table public.automation_accounts (
    account_id text primary key,
    user_id uuid not null references auth.users (id) on delete cascade,
    paused boolean not null default false,
    -- null when the owner paused it; set when the Worker held replies because Instagram refused the account's token
    paused_reason text,
    cooldown_until timestamptz,
    cooldown_reason text,
    subscribed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint automation_accounts_account_fkey foreign key (account_id, user_id)
        references public.accounts (id, user_id) on delete cascade,
    constraint automation_accounts_paused_reason_check check (paused_reason is null or char_length(paused_reason) <= 200),
    constraint automation_accounts_cooldown_reason_check check (cooldown_reason is null or char_length(cooldown_reason) <= 200)
);
-- turns on row level security and removes browser access to automation_accounts
alter table public.automation_accounts enable row level security;
revoke all on table public.automation_accounts from anon, authenticated;
-- adds the trigger that keeps updated_at current on automation_accounts
create trigger automation_accounts_set_updated_at before update on public.automation_accounts
    for each row execute function public.set_updated_at();
-- creates automation_rules, which holds the rules that answer Instagram comments
create table public.automation_rules (
    id text primary key,
    user_id uuid not null references auth.users (id) on delete cascade,
    account_id text not null,
    name text not null,
    keywords text[] not null,
    match_mode text not null default 'contains',
    case_sensitive boolean not null default false,
    -- empty means every post and reel of the account
    media_ids text[] not null default '{}',
    reply_text text not null,
    link_url text,
    enabled boolean not null default false,
    hourly_limit integer,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint automation_rules_account_fkey foreign key (account_id, user_id)
        references public.accounts (id, user_id) on delete cascade,
    constraint automation_rules_name_check check (char_length(name) between 1 and 80),
    constraint automation_rules_keywords_check check (cardinality(keywords) between 1 and 10),
    constraint automation_rules_match_mode_check check (match_mode in ('contains', 'exact')),
    constraint automation_rules_media_ids_check check (cardinality(media_ids) <= 50),
    constraint automation_rules_reply_text_check check (char_length(reply_text) between 1 and 1000),
    constraint automation_rules_link_url_check check (link_url is null or link_url ~ '^https://'),
    -- Instagram allows 750 private replies an hour per account for posts and reels
    constraint automation_rules_hourly_limit_check check (hourly_limit is null or hourly_limit between 1 and 750)
);
-- turns on row level security and removes browser access to automation_rules
alter table public.automation_rules enable row level security;
revoke all on table public.automation_rules from anon, authenticated;
-- adds the trigger that keeps updated_at current on automation_rules
create trigger automation_rules_set_updated_at before update on public.automation_rules
    for each row execute function public.set_updated_at();
-- adds an index that lists a user's rules in the order they were made
create index automation_rules_user_id_created_at_idx on public.automation_rules (user_id, created_at, id);
-- adds an index that finds an account's enabled rules when a comment arrives
create index automation_rules_enabled_account_idx on public.automation_rules (account_id) where enabled;
-- creates automation_comments, which stores each comment the webhook receives and is also the queue of private replies
create table public.automation_comments (
    id text primary key,
    user_id uuid not null references auth.users (id) on delete cascade,
    account_id text not null,
    rule_id text references public.automation_rules (id) on delete set null,
    -- the professional account the webhook named, so a comment is stored once however many members connected that account
    ig_user_id text not null,
    comment_id text not null,
    media_id text,
    from_id text,
    from_username text,
    -- kept only for matched comments; others are counted without their words
    text text,
    status text not null,
    status_reason text,
    error_message text,
    attempts integer not null default 0,
    next_attempt_at timestamptz,
    claimed_at timestamptz,
    message_id text,
    accepted_at timestamptz,
    -- when Meta sent the notification; private replies close 7 days after the comment
    notified_at timestamptz not null,
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint automation_comments_account_fkey foreign key (account_id, user_id)
        references public.accounts (id, user_id) on delete cascade,
    -- Meta delivers a notification again until it is acknowledged, so the second copy is refused here
    constraint automation_comments_comment_key unique (ig_user_id, comment_id),
    constraint automation_comments_status_check check (status in (
        'ignored', 'queued', 'processing', 'retry_wait', 'sending', 'accepted', 'failed', 'needs_review', 'skipped', 'expired'
    )),
    constraint automation_comments_waiting_check check (status not in ('queued', 'retry_wait') or next_attempt_at is not null),
    constraint automation_comments_attempts_check check (attempts >= 0),
    -- Instagram comments are at most 2,200 characters
    constraint automation_comments_text_check check (text is null or char_length(text) <= 2200),
    constraint automation_comments_error_message_check check (error_message is null or char_length(error_message) <= 500)
);
-- turns on row level security and removes browser access to automation_comments
alter table public.automation_comments enable row level security;
revoke all on table public.automation_comments from anon, authenticated;
-- adds the trigger that keeps updated_at current on automation_comments
create trigger automation_comments_set_updated_at before update on public.automation_comments
    for each row execute function public.set_updated_at();
-- adds an index that finds replies waiting to be sent, without reading old comments
create index automation_comments_due_idx on public.automation_comments (next_attempt_at) where status in ('queued', 'retry_wait');
-- adds an index that finds replies held by a run that stopped
create index automation_comments_claimed_idx on public.automation_comments (claimed_at) where status in ('processing', 'sending');
-- adds an index that lists a user's comments newest first
create index automation_comments_user_id_created_at_idx on public.automation_comments (user_id, created_at desc);
-- adds an index that finds the comments of one rule
create index automation_comments_rule_id_idx on public.automation_comments (rule_id) where rule_id is not null;
-- adds an index that finds the oldest comments for the daily clean-up
create index automation_comments_created_at_idx on public.automation_comments (created_at);
-- creates automation_attempts, which records every request sent to Instagram so the sending limits can count them
create table public.automation_attempts (
    id text primary key,
    user_id uuid not null references auth.users (id) on delete cascade,
    account_id text not null,
    automation_comment_id text not null references public.automation_comments (id) on delete cascade,
    rule_id text references public.automation_rules (id) on delete set null,
    recipient_id text,
    outcome text not null default 'sending',
    error_code integer,
    error_subcode integer,
    http_status integer,
    started_at timestamptz not null default now(),
    finished_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint automation_attempts_account_fkey foreign key (account_id, user_id)
        references public.accounts (id, user_id) on delete cascade,
    constraint automation_attempts_outcome_check check (outcome in ('sending', 'accepted', 'rejected', 'rate_limited', 'ambiguous'))
);
-- turns on row level security and removes browser access to automation_attempts
alter table public.automation_attempts enable row level security;
revoke all on table public.automation_attempts from anon, authenticated;
-- adds the trigger that keeps updated_at current on automation_attempts
create trigger automation_attempts_set_updated_at before update on public.automation_attempts
    for each row execute function public.set_updated_at();
-- adds an index that counts the instance's sends in the last hour
create index automation_attempts_started_at_idx on public.automation_attempts (started_at);
-- adds an index that counts one user's sends in the last hour
create index automation_attempts_user_id_started_at_idx on public.automation_attempts (user_id, started_at);
-- adds an index that counts one Instagram account's sends in the last hour
create index automation_attempts_account_id_started_at_idx on public.automation_attempts (account_id, started_at);
-- adds an index that counts one rule's sends in the last hour
create index automation_attempts_rule_id_started_at_idx on public.automation_attempts (rule_id, started_at) where rule_id is not null;
-- adds an index that counts the replies one person got from one account in the last day
create index automation_attempts_recipient_idx on public.automation_attempts (account_id, recipient_id, started_at);
-- adds an index that finds the attempts of one comment
create index automation_attempts_comment_idx on public.automation_attempts (automation_comment_id);
-- creates audit_events, which records who connected, removed or changed what
create table public.audit_events (
    id text primary key,
    user_id uuid not null references auth.users (id) on delete cascade,
    action text not null,
    subject_type text not null,
    subject_id text,
    details jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint audit_events_action_check check (action ~ '^[a-z_]+\.[a-z_]+$'),
    constraint audit_events_subject_type_check check (subject_type in ('account', 'automation_rule', 'automation_account', 'automation_comment')),
    constraint audit_events_details_check check (jsonb_typeof(details) = 'object')
);
-- turns on row level security and removes browser access to audit_events
alter table public.audit_events enable row level security;
revoke all on table public.audit_events from anon, authenticated;
-- adds the trigger that keeps updated_at current on audit_events
create trigger audit_events_set_updated_at before update on public.audit_events
    for each row execute function public.set_updated_at();
-- adds an index that lists a user's audit events newest first
create index audit_events_user_id_created_at_idx on public.audit_events (user_id, created_at desc);
-- adds an index that finds the oldest audit events for the daily clean-up
create index audit_events_created_at_idx on public.audit_events (created_at);
-- adds an index that finds an account by its Instagram id when a webhook arrives
create index if not exists accounts_instagram_user_idx on public.accounts ((data ->> 'igUserId')) where platform = 'instagram';
-- creates automation_rules_for_ig_user, which returns the enabled rules for the Instagram account a webhook names
create or replace function public.automation_rules_for_ig_user(p_ig_user_id text)
returns table (
    id text,
    user_id uuid,
    account_id text,
    keywords text[],
    match_mode text,
    case_sensitive boolean,
    media_ids text[],
    created_at timestamptz
)
language sql
stable
set search_path = ''
as $$
    select r.id, r.user_id, r.account_id, r.keywords, r.match_mode, r.case_sensitive, r.media_ids, r.created_at
    from public.accounts a
    join public.automation_rules r on r.account_id = a.id and r.user_id = a.user_id
    where a.platform = 'instagram'
        and a.data ->> 'igUserId' = p_ig_user_id
        and r.enabled
    order by a.created_at, a.id, r.created_at, r.id;
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.automation_rules_for_ig_user(text) from public, anon, authenticated;
grant execute on function public.automation_rules_for_ig_user(text) to service_role;
-- creates claim_automation_comments, which hands a run the private replies that are due to be sent
create or replace function public.claim_automation_comments(
    p_limit integer,
    p_per_account integer,
    p_lease_seconds integer,
    p_ids text[] default null
)
returns table (
    id text,
    user_id uuid,
    account_id text,
    rule_id text,
    ig_user_id text,
    comment_id text,
    from_id text,
    attempts integer,
    expires_at timestamptz,
    rule_enabled boolean,
    reply_text text,
    link_url text,
    access_token text
)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
    stale_before timestamptz := now() - make_interval(secs => p_lease_seconds);
begin
    -- a send whose run stopped may have reached Instagram, so a person decides instead of a second send
    with interrupted as (
        update public.automation_comments c
        set status = 'needs_review',
            status_reason = 'interrupted',
            claimed_at = null,
            error_message = 'The run stopped while this reply was being sent. Check the conversation on Instagram before you retry.'
        where c.status = 'sending' and c.claimed_at < stale_before
        returning c.id
    )
    update public.automation_attempts t
    set outcome = 'ambiguous', finished_at = now()
    where t.automation_comment_id in (select interrupted.id from interrupted) and t.outcome = 'sending';

    return query
    with due as (
        select c.id, c.account_id, coalesce(c.next_attempt_at, c.claimed_at) as due_at
        from public.automation_comments c
        where ((c.status in ('queued', 'retry_wait') and c.next_attempt_at <= now())
                or (c.status = 'processing' and c.claimed_at < stale_before))
            and (p_ids is null or c.id = any (p_ids))
        order by due_at
        limit p_limit * 10
    ),
    fair as (
        select due.id, due.due_at, row_number() over (partition by due.account_id order by due.due_at) as place
        from due
    ),
    picked as (
        -- the status test is repeated on the locked row, so a job another run claimed in between is left alone
        select c.id
        from public.automation_comments c
        join fair on fair.id = c.id
        where fair.place <= p_per_account
            and ((c.status in ('queued', 'retry_wait') and c.next_attempt_at <= now())
                or (c.status = 'processing' and c.claimed_at < stale_before))
        order by fair.due_at
        limit p_limit
        for update of c skip locked
    ),
    claimed as (
        update public.automation_comments c
        set status = 'processing', claimed_at = now()
        from picked
        where c.id = picked.id
        returning c.id, c.user_id, c.account_id, c.rule_id, c.ig_user_id, c.comment_id, c.from_id, c.attempts, c.expires_at
    )
    select claimed.id, claimed.user_id, claimed.account_id, claimed.rule_id, claimed.ig_user_id, claimed.comment_id,
        claimed.from_id, claimed.attempts, claimed.expires_at,
        coalesce(r.enabled, false), r.reply_text, r.link_url, a.data ->> 'accessToken'
    from claimed
    left join public.automation_rules r on r.id = claimed.rule_id
    left join public.accounts a on a.id = claimed.account_id and a.user_id = claimed.user_id;
end;
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.claim_automation_comments(integer, integer, integer, text[]) from public, anon, authenticated;
grant execute on function public.claim_automation_comments(integer, integer, integer, text[]) to service_role;
-- creates reserve_automation_send, which checks the limits and records an attempt before a private reply is sent
create or replace function public.reserve_automation_send(
    p_id text,
    p_attempt_id text,
    p_global_limit integer,
    p_user_limit integer,
    p_account_limit integer,
    p_recipient_limit integer
)
returns table (outcome text, retry_at timestamptz)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
    job public.automation_comments%rowtype;
    controls public.automation_accounts%rowtype;
    rule_limit integer;
    hour_ago timestamptz := now() - interval '1 hour';
    free_at timestamptz;
begin
    -- one reservation at a time across every Worker, so two jobs cannot both take the last free send
    perform pg_advisory_xact_lock(hashtext('reserve_automation_send'));

    select * into job from public.automation_comments c where c.id = p_id and c.status = 'processing' for update;
    if not found then
        return query select 'gone'::text, null::timestamptz;
        return;
    end if;

    select * into controls from public.automation_accounts a where a.account_id = job.account_id;
    if controls.paused then
        return query select 'paused'::text, null::timestamptz;
        return;
    end if;
    if controls.cooldown_until > now() then
        return query select 'cooldown'::text, controls.cooldown_until;
        return;
    end if;

    -- a person who comments again and again gets a few replies a day, never a stream of them; retries of this
    -- comment are one reply, so only other comments count
    if job.from_id is not null and (
        select count(distinct t.automation_comment_id) from public.automation_attempts t
        where t.account_id = job.account_id and t.recipient_id = job.from_id
            and t.started_at > now() - interval '1 day' and t.automation_comment_id <> job.id
    ) >= p_recipient_limit then
        return query select 'recipient_limit'::text, null::timestamptz;
        return;
    end if;

    -- when a scope is full, a send frees up an hour after the oldest one in the window
    select r.hourly_limit into rule_limit from public.automation_rules r where r.id = job.rule_id;
    if rule_limit is not null then
        select case when count(*) >= rule_limit then min(t.started_at) + interval '1 hour' end into free_at
        from public.automation_attempts t where t.rule_id = job.rule_id and t.started_at > hour_ago;
        if free_at is not null then
            return query select 'rule_limit'::text, free_at;
            return;
        end if;
    end if;

    select case when count(*) >= p_account_limit then min(t.started_at) + interval '1 hour' end into free_at
    from public.automation_attempts t where t.account_id = job.account_id and t.started_at > hour_ago;
    if free_at is not null then
        return query select 'account_limit'::text, free_at;
        return;
    end if;

    select case when count(*) >= p_user_limit then min(t.started_at) + interval '1 hour' end into free_at
    from public.automation_attempts t where t.user_id = job.user_id and t.started_at > hour_ago;
    if free_at is not null then
        return query select 'user_limit'::text, free_at;
        return;
    end if;

    select case when count(*) >= p_global_limit then min(t.started_at) + interval '1 hour' end into free_at
    from public.automation_attempts t where t.started_at > hour_ago;
    if free_at is not null then
        return query select 'global_limit'::text, free_at;
        return;
    end if;

    update public.automation_comments c
    set status = 'sending', claimed_at = now(), attempts = c.attempts + 1
    where c.id = p_id;
    insert into public.automation_attempts (id, user_id, account_id, automation_comment_id, rule_id, recipient_id)
    values (p_attempt_id, job.user_id, job.account_id, job.id, job.rule_id, job.from_id);
    return query select 'ok'::text, null::timestamptz;
end;
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.reserve_automation_send(text, text, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.reserve_automation_send(text, text, integer, integer, integer, integer) to service_role;
-- creates finish_automation_send, which saves what Instagram answered to a private reply
create or replace function public.finish_automation_send(
    p_id text,
    p_attempt_id text,
    p_status text,
    p_outcome text,
    p_reason text default null,
    p_error_message text default null,
    p_message_id text default null,
    p_error_code integer default null,
    p_error_subcode integer default null,
    p_http_status integer default null,
    p_next_attempt_at timestamptz default null,
    p_cooldown_until timestamptz default null,
    p_cooldown_reason text default null,
    p_pause_reason text default null
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
    job public.automation_comments%rowtype;
begin
    update public.automation_comments c
    set status = p_status,
        status_reason = p_reason,
        error_message = p_error_message,
        message_id = coalesce(p_message_id, c.message_id),
        accepted_at = case when p_status = 'accepted' then now() else c.accepted_at end,
        next_attempt_at = p_next_attempt_at,
        claimed_at = null
    where c.id = p_id and (c.status = 'sending' or (c.status = 'needs_review' and c.status_reason = 'interrupted'))
    returning * into job;
    -- a comment already settled keeps the attempt that settled it
    if not found then
        return false;
    end if;

    update public.automation_attempts t
    set outcome = p_outcome,
        error_code = p_error_code,
        error_subcode = p_error_subcode,
        http_status = p_http_status,
        finished_at = now()
    where t.id = p_attempt_id and t.automation_comment_id = p_id;

    if p_cooldown_until is not null then
        insert into public.automation_accounts (account_id, user_id, cooldown_until, cooldown_reason)
        values (job.account_id, job.user_id, p_cooldown_until, p_cooldown_reason)
        on conflict (account_id) do update
        set cooldown_until = greatest(coalesce(public.automation_accounts.cooldown_until, excluded.cooldown_until), excluded.cooldown_until),
            cooldown_reason = excluded.cooldown_reason;
    end if;

    if p_pause_reason is not null then
        insert into public.automation_accounts (account_id, user_id, paused, paused_reason)
        values (job.account_id, job.user_id, true, p_pause_reason)
        on conflict (account_id) do update set paused = true, paused_reason = excluded.paused_reason;
    end if;
    return true;
end;
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.finish_automation_send(text, text, text, text, text, text, text, integer, integer, integer, timestamptz, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.finish_automation_send(text, text, text, text, text, text, text, integer, integer, integer, timestamptz, timestamptz, text, text) to service_role;
-- creates automation_stats, which counts a user's comments and requests for a period
create or replace function public.automation_stats(
    p_user_id uuid,
    p_from timestamptz,
    p_to timestamptz,
    p_account_id text default null,
    p_rule_id text default null
)
returns jsonb
language sql
stable
set search_path = ''
as $$
    select jsonb_build_object(
        'comments', coalesce((
            select jsonb_object_agg(counted.status, counted.total)
            from (
                select c.status, count(*) as total
                from public.automation_comments c
                where c.user_id = p_user_id
                    and c.created_at >= p_from and c.created_at < p_to
                    and (p_account_id is null or c.account_id = p_account_id)
                    and (p_rule_id is null or c.rule_id = p_rule_id)
                group by c.status
            ) counted
        ), '{}'::jsonb),
        'attempts', coalesce((
            select jsonb_object_agg(counted.outcome, counted.total)
            from (
                select t.outcome, count(*) as total
                from public.automation_attempts t
                where t.user_id = p_user_id
                    and t.started_at >= p_from and t.started_at < p_to
                    and (p_account_id is null or t.account_id = p_account_id)
                    and (p_rule_id is null or t.rule_id = p_rule_id)
                group by t.outcome
            ) counted
        ), '{}'::jsonb)
    );
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.automation_stats(uuid, timestamptz, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.automation_stats(uuid, timestamptz, timestamptz, text, text) to service_role;
-- adds rules that answer any comment and the followers-only option to automation_rules
alter table public.automation_rules
    drop constraint automation_rules_match_mode_check,
    drop constraint automation_rules_keywords_check,
    add column require_follow boolean not null default false,
    add column follow_prompt_text text,
    add column not_following_text text,
    add constraint automation_rules_match_mode_check check (match_mode in ('contains', 'exact', 'any')),
    -- an any-comment rule has no keywords; a keyword rule has 1 to 10
    add constraint automation_rules_keywords_check check (
        case when match_mode = 'any' then cardinality(keywords) = 0 else cardinality(keywords) between 1 and 10 end
    ),
    add constraint automation_rules_follow_prompt_text_check check (follow_prompt_text is null or char_length(follow_prompt_text) between 1 and 1000),
    add constraint automation_rules_not_following_text_check check (not_following_text is null or char_length(not_following_text) between 1 and 1000),
    add constraint automation_rules_follow_texts_check check (not require_follow or (follow_prompt_text is not null and not_following_text is not null));
-- adds the followers-only wait and the review checks to automation_comments
alter table public.automation_comments
    -- the person Instagram says received the private reply, so their answer can be matched to this comment
    add column recipient_id text,
    -- followers-only rules: waiting for the person to reply, link sent, or no more reminders
    add column gate_status text,
    add column gate_prompts integer not null default 0,
    -- checks of a reply whose outcome was unknown against the conversation on Instagram
    add column review_checks integer not null default 0,
    add column review_checked_at timestamptz,
    add constraint automation_comments_gate_status_check check (gate_status is null or gate_status in ('awaiting_reply', 'completed', 'closed')),
    add constraint automation_comments_gate_prompts_check check (gate_prompts >= 0),
    add constraint automation_comments_review_checks_check check (review_checks >= 0);
-- adds the hourly limit marker and the confirmed webhook fields to automation_accounts
alter table public.automation_accounts
    -- set when the account reached its hourly reply limit, so runs leave its jobs alone until a send frees up
    add column limited_until timestamptz,
    -- the webhook fields Instagram confirmed for the account; follow checks need messages as well as comments
    add column subscribed_fields text[];
-- creates automation_followups, which holds the message sent after someone answers a followers-only reply
create table public.automation_followups (
    id text primary key,
    user_id uuid not null references auth.users (id) on delete cascade,
    account_id text not null,
    automation_comment_id text not null references public.automation_comments (id) on delete cascade,
    ig_user_id text not null,
    recipient_id text not null,
    -- the person's message; Meta delivers a notification again until it is acknowledged
    trigger_message_id text not null,
    status text not null,
    status_reason text,
    error_message text,
    -- what was sent: set once the follow check answers
    kind text,
    attempts integer not null default 0,
    next_attempt_at timestamptz,
    claimed_at timestamptz,
    message_id text,
    accepted_at timestamptz,
    -- the person's message time plus 24 hours, Instagram's standard messaging window
    window_expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint automation_followups_account_fkey foreign key (account_id, user_id)
        references public.accounts (id, user_id) on delete cascade,
    constraint automation_followups_message_key unique (ig_user_id, trigger_message_id),
    constraint automation_followups_status_check check (status in (
        'queued', 'processing', 'retry_wait', 'sending', 'accepted', 'failed', 'needs_review', 'skipped', 'expired'
    )),
    constraint automation_followups_waiting_check check (status not in ('queued', 'retry_wait') or next_attempt_at is not null),
    constraint automation_followups_kind_check check (kind is null or kind in ('link', 'reminder')),
    constraint automation_followups_attempts_check check (attempts >= 0),
    constraint automation_followups_error_message_check check (error_message is null or char_length(error_message) <= 500)
);
-- turns on row level security and removes browser access to automation_followups
alter table public.automation_followups enable row level security;
revoke all on table public.automation_followups from anon, authenticated;
-- adds the trigger that keeps updated_at current on automation_followups
create trigger automation_followups_set_updated_at before update on public.automation_followups
    for each row execute function public.set_updated_at();
-- adds an index that finds each account's follow-ups waiting to be sent
create index automation_followups_due_idx on public.automation_followups (account_id, next_attempt_at) where status in ('queued', 'retry_wait');
-- adds an index that finds follow-ups held by a run that stopped
create index automation_followups_claimed_idx on public.automation_followups (claimed_at) where status in ('processing', 'sending');
-- allows only one open follow-up per comment, so several messages from one person get one answer
create unique index automation_followups_open_comment_key on public.automation_followups (automation_comment_id)
    where status in ('queued', 'processing', 'retry_wait', 'sending');
-- adds an index that finds the follow-ups of one comment
create index automation_followups_comment_id_idx on public.automation_followups (automation_comment_id, created_at);
-- adds the attempt kind, the follow-up link and a digest of the text sent to automation_attempts
alter table public.automation_attempts
    -- private replies count against Instagram's 750 an hour per account; follow-ups go through the Send API instead
    add column kind text not null default 'private_reply',
    -- sha-256 of the text sent, so a reply whose answer was lost can be recognised in the conversation later
    add column message_digest text,
    add column followup_id text references public.automation_followups (id) on delete cascade,
    add constraint automation_attempts_kind_check check (kind in ('private_reply', 'followup')),
    add constraint automation_attempts_followup_check check ((kind = 'followup') = (followup_id is not null));
-- adds an index that finds each account's oldest due replies, so accounts can take turns
create index automation_comments_due_account_idx on public.automation_comments (account_id, next_attempt_at) where status in ('queued', 'retry_wait');
-- adds an index that finds the followers-only replies waiting for a person's answer
create index automation_comments_awaiting_reply_idx on public.automation_comments (ig_user_id, recipient_id, accepted_at) where gate_status = 'awaiting_reply';
-- adds an index that finds replies whose outcome is unknown
create index automation_comments_needs_review_idx on public.automation_comments (review_checked_at nulls first, updated_at) where status = 'needs_review';
-- replaces claim_automation_comments so accounts take turns and paused, cooling or limited accounts are skipped
drop function if exists public.claim_automation_comments(integer, integer, integer, text[]);
create or replace function public.claim_automation_comments(
    p_limit integer,
    p_per_account integer,
    p_lease_seconds integer,
    p_ids text[] default null
)
returns table (
    id text,
    user_id uuid,
    account_id text,
    rule_id text,
    ig_user_id text,
    comment_id text,
    from_id text,
    attempts integer,
    expires_at timestamptz,
    rule_enabled boolean,
    reply_text text,
    link_url text,
    access_token text,
    require_follow boolean,
    follow_prompt_text text
)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
    stale_before timestamptz := now() - make_interval(secs => p_lease_seconds);
begin
    -- a send whose run stopped may have reached Instagram, so a person decides instead of a second send
    with interrupted as (
        update public.automation_comments c
        set status = 'needs_review',
            status_reason = 'interrupted',
            claimed_at = null,
            error_message = 'The run stopped while this reply was being sent. Check the conversation on Instagram before you retry.'
        where c.status = 'sending' and c.claimed_at < stale_before
        returning c.id
    )
    update public.automation_attempts t
    set outcome = 'ambiguous', finished_at = now()
    where t.automation_comment_id in (select interrupted.id from interrupted) and t.outcome = 'sending';

    return query
    with recursive waiting_accounts as (
        -- one index probe per account instead of reading every waiting job, however long one account's queue is
        (select c.account_id
        from public.automation_comments c
        where c.status in ('queued', 'retry_wait') and p_ids is null
        order by c.account_id
        limit 1)
        union all
        select (select c.account_id
            from public.automation_comments c
            where c.status in ('queued', 'retry_wait') and c.account_id > w.account_id
            order by c.account_id
            limit 1)
        from waiting_accounts w
        where w.account_id is not null
    ),
    due_accounts as (
        select w.account_id from waiting_accounts w where w.account_id is not null
        union
        select c.account_id from public.automation_comments c where c.id = any (p_ids)
        union
        select c.account_id
        from public.automation_comments c
        where c.status = 'processing' and c.claimed_at < stale_before and (p_ids is null or c.id = any (p_ids))
    ),
    open_accounts as (
        select d.account_id
        from due_accounts d
        left join public.automation_accounts s on s.account_id = d.account_id
        where s.account_id is null
            or (not s.paused
                and (s.cooldown_until is null or s.cooldown_until <= now())
                and (s.limited_until is null or s.limited_until <= now()))
    ),
    -- each account's oldest due jobs, locked as they are read: a job another run holds is skipped, so runs at the
    -- same moment take the next jobs instead of the same ones
    candidates as (
        select x.id, x.account_id, x.next_attempt_at as due_at
        from open_accounts o
        cross join lateral (
            select c.id, c.account_id, c.next_attempt_at
            from public.automation_comments c
            where c.account_id = o.account_id and c.status in ('queued', 'retry_wait') and c.next_attempt_at <= now()
                and (p_ids is null or c.id = any (p_ids))
            order by c.next_attempt_at
            limit p_per_account
            for update of c skip locked
        ) x
        union all
        select x.id, x.account_id, x.claimed_at as due_at
        from open_accounts o
        cross join lateral (
            select c.id, c.account_id, c.claimed_at
            from public.automation_comments c
            where c.account_id = o.account_id and c.status = 'processing' and c.claimed_at < stale_before
                and (p_ids is null or c.id = any (p_ids))
            order by c.claimed_at
            limit p_per_account
            for update of c skip locked
        ) x
    ),
    picked as (
        select ranked.id
        from (
            select candidates.id, candidates.due_at,
                row_number() over (partition by candidates.account_id order by candidates.due_at, candidates.id) as place
            from candidates
        ) ranked
        order by ranked.place, ranked.due_at
        limit p_limit
    ),
    claimed as (
        update public.automation_comments c
        set status = 'processing', claimed_at = now()
        from picked
        where c.id = picked.id
        returning c.id, c.user_id, c.account_id, c.rule_id, c.ig_user_id, c.comment_id, c.from_id, c.attempts, c.expires_at
    )
    select claimed.id, claimed.user_id, claimed.account_id, claimed.rule_id, claimed.ig_user_id, claimed.comment_id,
        claimed.from_id, claimed.attempts, claimed.expires_at,
        coalesce(r.enabled, false), r.reply_text, r.link_url, a.data ->> 'accessToken',
        coalesce(r.require_follow, false), r.follow_prompt_text
    from claimed
    left join public.automation_rules r on r.id = claimed.rule_id
    left join public.accounts a on a.id = claimed.account_id and a.user_id = claimed.user_id;
end;
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.claim_automation_comments(integer, integer, integer, text[]) from public, anon, authenticated;
grant execute on function public.claim_automation_comments(integer, integer, integer, text[]) to service_role;
-- replaces reserve_automation_send so it counts private replies only and marks an account that reached its limit
drop function if exists public.reserve_automation_send(text, text, integer, integer, integer, integer);
create or replace function public.reserve_automation_send(
    p_id text,
    p_attempt_id text,
    p_global_limit integer,
    p_user_limit integer,
    p_account_limit integer,
    p_recipient_limit integer,
    p_message_digest text default null
)
returns table (outcome text, retry_at timestamptz)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
    job public.automation_comments%rowtype;
    controls public.automation_accounts%rowtype;
    rule_limit integer;
    hour_ago timestamptz := now() - interval '1 hour';
    free_at timestamptz;
begin
    -- one reservation at a time across every Worker, so two jobs cannot both take the last free send
    perform pg_advisory_xact_lock(hashtext('reserve_automation_send'));

    select * into job from public.automation_comments c where c.id = p_id and c.status = 'processing' for update;
    if not found then
        return query select 'gone'::text, null::timestamptz;
        return;
    end if;

    select * into controls from public.automation_accounts a where a.account_id = job.account_id;
    if controls.paused then
        return query select 'paused'::text, null::timestamptz;
        return;
    end if;
    if controls.cooldown_until > now() then
        return query select 'cooldown'::text, controls.cooldown_until;
        return;
    end if;

    -- a person who comments again and again gets a few replies a day, never a stream of them; retries of this
    -- comment are one reply, so only other comments count
    if job.from_id is not null and (
        select count(distinct t.automation_comment_id) from public.automation_attempts t
        where t.account_id = job.account_id and t.recipient_id = job.from_id and t.kind = 'private_reply'
            and t.started_at > now() - interval '1 day' and t.automation_comment_id <> job.id
    ) >= p_recipient_limit then
        return query select 'recipient_limit'::text, null::timestamptz;
        return;
    end if;

    -- when a scope is full, a send frees up an hour after the oldest one in the window
    select r.hourly_limit into rule_limit from public.automation_rules r where r.id = job.rule_id;
    if rule_limit is not null then
        select case when count(*) >= rule_limit then min(t.started_at) + interval '1 hour' end into free_at
        from public.automation_attempts t where t.rule_id = job.rule_id and t.kind = 'private_reply' and t.started_at > hour_ago;
        if free_at is not null then
            return query select 'rule_limit'::text, free_at;
            return;
        end if;
    end if;

    select case when count(*) >= p_account_limit then min(t.started_at) + interval '1 hour' end into free_at
    from public.automation_attempts t where t.account_id = job.account_id and t.kind = 'private_reply' and t.started_at > hour_ago;
    if free_at is not null then
        insert into public.automation_accounts (account_id, user_id, limited_until)
        values (job.account_id, job.user_id, free_at)
        on conflict (account_id) do update set limited_until = excluded.limited_until;
        return query select 'account_limit'::text, free_at;
        return;
    end if;

    select case when count(*) >= p_user_limit then min(t.started_at) + interval '1 hour' end into free_at
    from public.automation_attempts t where t.user_id = job.user_id and t.kind = 'private_reply' and t.started_at > hour_ago;
    if free_at is not null then
        return query select 'user_limit'::text, free_at;
        return;
    end if;

    select case when count(*) >= p_global_limit then min(t.started_at) + interval '1 hour' end into free_at
    from public.automation_attempts t where t.kind = 'private_reply' and t.started_at > hour_ago;
    if free_at is not null then
        return query select 'global_limit'::text, free_at;
        return;
    end if;

    update public.automation_comments c
    set status = 'sending', claimed_at = now(), attempts = c.attempts + 1
    where c.id = p_id;
    insert into public.automation_attempts (id, user_id, account_id, automation_comment_id, rule_id, recipient_id, message_digest)
    values (p_attempt_id, job.user_id, job.account_id, job.id, job.rule_id, job.from_id, p_message_digest);
    return query select 'ok'::text, null::timestamptz;
end;
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.reserve_automation_send(text, text, integer, integer, integer, integer, text) from public, anon, authenticated;
grant execute on function public.reserve_automation_send(text, text, integer, integer, integer, integer, text) to service_role;
-- replaces finish_automation_send so it keeps who received the reply and starts the followers-only wait
drop function if exists public.finish_automation_send(text, text, text, text, text, text, text, integer, integer, integer, timestamptz, timestamptz, text, text);
create or replace function public.finish_automation_send(
    p_id text,
    p_attempt_id text,
    p_status text,
    p_outcome text,
    p_reason text default null,
    p_error_message text default null,
    p_message_id text default null,
    p_error_code integer default null,
    p_error_subcode integer default null,
    p_http_status integer default null,
    p_next_attempt_at timestamptz default null,
    p_cooldown_until timestamptz default null,
    p_cooldown_reason text default null,
    p_pause_reason text default null,
    p_recipient_id text default null,
    p_gate_status text default null
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
    job public.automation_comments%rowtype;
begin
    update public.automation_comments c
    set status = p_status,
        status_reason = p_reason,
        error_message = p_error_message,
        message_id = coalesce(p_message_id, c.message_id),
        accepted_at = case when p_status = 'accepted' then now() else c.accepted_at end,
        recipient_id = coalesce(p_recipient_id, c.recipient_id),
        gate_status = coalesce(p_gate_status, c.gate_status),
        next_attempt_at = p_next_attempt_at,
        claimed_at = null
    where c.id = p_id and (c.status = 'sending' or (c.status = 'needs_review' and c.status_reason = 'interrupted'))
    returning * into job;
    -- a comment already settled keeps the attempt that settled it
    if not found then
        return false;
    end if;

    update public.automation_attempts t
    set outcome = p_outcome,
        error_code = p_error_code,
        error_subcode = p_error_subcode,
        http_status = p_http_status,
        finished_at = now()
    where t.id = p_attempt_id and t.automation_comment_id = p_id;

    if p_cooldown_until is not null then
        insert into public.automation_accounts (account_id, user_id, cooldown_until, cooldown_reason)
        values (job.account_id, job.user_id, p_cooldown_until, p_cooldown_reason)
        on conflict (account_id) do update
        set cooldown_until = greatest(coalesce(public.automation_accounts.cooldown_until, excluded.cooldown_until), excluded.cooldown_until),
            cooldown_reason = excluded.cooldown_reason;
    end if;

    if p_pause_reason is not null then
        insert into public.automation_accounts (account_id, user_id, paused, paused_reason)
        values (job.account_id, job.user_id, true, p_pause_reason)
        on conflict (account_id) do update set paused = true, paused_reason = excluded.paused_reason;
    end if;
    return true;
end;
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.finish_automation_send(text, text, text, text, text, text, text, integer, integer, integer, timestamptz, timestamptz, text, text, text, text) from public, anon, authenticated;
grant execute on function public.finish_automation_send(text, text, text, text, text, text, text, integer, integer, integer, timestamptz, timestamptz, text, text, text, text) to service_role;
-- creates automation_followups_for_messages, which turns answers to followers-only replies into follow-up jobs
create or replace function public.automation_followups_for_messages(p_ig_user_id text, p_messages jsonb)
returns table (id text)
language sql
set search_path = ''
as $$
    with incoming as (
        select m.id, m.sender_id, m.message_id, m.sent_at
        from jsonb_to_recordset(p_messages) as m (id text, sender_id text, message_id text, sent_at timestamptz)
        where m.id is not null and m.sender_id is not null and m.message_id is not null and m.sent_at is not null
    ),
    waiting as (
        -- the sender's newest reply that waits for them; a minute of slack covers the two clocks, and a reply older
        -- than 7 days no longer waits
        select distinct on (i.message_id)
            i.id as followup_id, i.message_id, i.sent_at, c.id as comment_id, c.user_id, c.account_id, c.recipient_id
        from incoming i
        join public.automation_comments c
            on c.ig_user_id = p_ig_user_id and c.recipient_id = i.sender_id and c.gate_status = 'awaiting_reply'
            and c.accepted_at <= i.sent_at + interval '1 minute' and c.accepted_at > i.sent_at - interval '7 days'
        order by i.message_id, c.accepted_at desc
    )
    insert into public.automation_followups as f (
        id, user_id, account_id, automation_comment_id, ig_user_id, recipient_id, trigger_message_id, status,
        next_attempt_at, window_expires_at
    )
    select w.followup_id, w.user_id, w.account_id, w.comment_id, p_ig_user_id, w.recipient_id, w.message_id, 'queued',
        now() - interval '30 seconds', w.sent_at + interval '1 day'
    from waiting w
    order by w.sent_at
    on conflict do nothing
    returning f.id;
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.automation_followups_for_messages(text, jsonb) from public, anon, authenticated;
grant execute on function public.automation_followups_for_messages(text, jsonb) to service_role;
-- creates claim_automation_followups, which hands a run the follow-ups that are due
create or replace function public.claim_automation_followups(
    p_limit integer,
    p_lease_seconds integer,
    p_ids text[] default null
)
returns table (
    id text,
    user_id uuid,
    account_id text,
    automation_comment_id text,
    ig_user_id text,
    recipient_id text,
    attempts integer,
    window_expires_at timestamptz,
    gate_status text,
    gate_prompts integer,
    rule_enabled boolean,
    require_follow boolean,
    reply_text text,
    link_url text,
    not_following_text text,
    access_token text
)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
    stale_before timestamptz := now() - make_interval(secs => p_lease_seconds);
begin
    -- as with private replies, a send whose run stopped may have arrived, so a person decides
    with interrupted as (
        update public.automation_followups f
        set status = 'needs_review',
            status_reason = 'interrupted',
            claimed_at = null,
            error_message = 'The run stopped while this message was being sent. Check the conversation on Instagram before you retry.'
        where f.status = 'sending' and f.claimed_at < stale_before
        returning f.id
    )
    update public.automation_attempts t
    set outcome = 'ambiguous', finished_at = now()
    where t.followup_id in (select interrupted.id from interrupted) and t.outcome = 'sending';

    return query
    with due_accounts as (
        select distinct f.account_id
        from public.automation_followups f
        where ((f.status in ('queued', 'retry_wait') and f.next_attempt_at <= now())
                or (f.status = 'processing' and f.claimed_at < stale_before))
            and (p_ids is null or f.id = any (p_ids))
    ),
    open_accounts as (
        select d.account_id
        from due_accounts d
        left join public.automation_accounts s on s.account_id = d.account_id
        where s.account_id is null or (not s.paused and (s.cooldown_until is null or s.cooldown_until <= now()))
    ),
    candidates as (
        select x.id, x.due_at, row_number() over (partition by o.account_id order by x.due_at, x.id) as place
        from open_accounts o
        cross join lateral (
            select f.id, coalesce(f.next_attempt_at, f.claimed_at) as due_at
            from public.automation_followups f
            where f.account_id = o.account_id
                and ((f.status in ('queued', 'retry_wait') and f.next_attempt_at <= now())
                    or (f.status = 'processing' and f.claimed_at < stale_before))
                and (p_ids is null or f.id = any (p_ids))
            order by due_at
            limit p_limit
        ) x
    ),
    picked as (
        select f.id
        from public.automation_followups f
        join candidates on candidates.id = f.id
        where (f.status in ('queued', 'retry_wait') and f.next_attempt_at <= now())
            or (f.status = 'processing' and f.claimed_at < stale_before)
        order by candidates.place, candidates.due_at
        limit p_limit
        for update of f skip locked
    ),
    claimed as (
        update public.automation_followups f
        set status = 'processing', claimed_at = now()
        from picked
        where f.id = picked.id
        returning f.id, f.user_id, f.account_id, f.automation_comment_id, f.ig_user_id, f.recipient_id, f.attempts, f.window_expires_at
    )
    select claimed.id, claimed.user_id, claimed.account_id, claimed.automation_comment_id, claimed.ig_user_id,
        claimed.recipient_id, claimed.attempts, claimed.window_expires_at, c.gate_status, c.gate_prompts,
        coalesce(r.enabled, false), coalesce(r.require_follow, false), r.reply_text, r.link_url, r.not_following_text,
        a.data ->> 'accessToken'
    from claimed
    join public.automation_comments c on c.id = claimed.automation_comment_id
    left join public.automation_rules r on r.id = c.rule_id
    left join public.accounts a on a.id = claimed.account_id and a.user_id = claimed.user_id;
end;
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.claim_automation_followups(integer, integer, text[]) from public, anon, authenticated;
grant execute on function public.claim_automation_followups(integer, integer, text[]) to service_role;
-- creates reserve_automation_followup, which checks the account and records an attempt before a follow-up is sent
create or replace function public.reserve_automation_followup(
    p_id text,
    p_attempt_id text,
    p_kind text,
    p_message_digest text default null
)
returns table (outcome text, retry_at timestamptz)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
    job public.automation_followups%rowtype;
    controls public.automation_accounts%rowtype;
    rule text;
begin
    select * into job from public.automation_followups f where f.id = p_id and f.status = 'processing' for update;
    if not found then
        return query select 'gone'::text, null::timestamptz;
        return;
    end if;

    select * into controls from public.automation_accounts a where a.account_id = job.account_id;
    if controls.paused then
        return query select 'paused'::text, null::timestamptz;
        return;
    end if;
    if controls.cooldown_until > now() then
        return query select 'cooldown'::text, controls.cooldown_until;
        return;
    end if;

    select c.rule_id into rule from public.automation_comments c where c.id = job.automation_comment_id;
    update public.automation_followups f
    set status = 'sending', claimed_at = now(), attempts = f.attempts + 1, kind = p_kind
    where f.id = p_id;
    insert into public.automation_attempts (id, user_id, account_id, automation_comment_id, rule_id, recipient_id, kind, followup_id, message_digest)
    values (p_attempt_id, job.user_id, job.account_id, job.automation_comment_id, rule, job.recipient_id, 'followup', job.id, p_message_digest);
    return query select 'ok'::text, null::timestamptz;
end;
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.reserve_automation_followup(text, text, text, text) from public, anon, authenticated;
grant execute on function public.reserve_automation_followup(text, text, text, text) to service_role;
-- creates finish_automation_followup, which saves what Instagram answered to a follow-up
create or replace function public.finish_automation_followup(
    p_id text,
    p_attempt_id text,
    p_status text,
    p_outcome text,
    p_reason text default null,
    p_error_message text default null,
    p_message_id text default null,
    p_error_code integer default null,
    p_error_subcode integer default null,
    p_http_status integer default null,
    p_next_attempt_at timestamptz default null,
    p_cooldown_until timestamptz default null,
    p_cooldown_reason text default null,
    p_pause_reason text default null,
    p_gate_status text default null,
    p_count_reminder boolean default false
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
    job public.automation_followups%rowtype;
begin
    update public.automation_followups f
    set status = p_status,
        status_reason = p_reason,
        error_message = p_error_message,
        message_id = coalesce(p_message_id, f.message_id),
        accepted_at = case when p_status = 'accepted' then now() else f.accepted_at end,
        next_attempt_at = p_next_attempt_at,
        claimed_at = null
    where f.id = p_id and (f.status = 'sending' or (f.status = 'needs_review' and f.status_reason = 'interrupted'))
    returning * into job;
    if not found then
        return false;
    end if;

    update public.automation_attempts t
    set outcome = p_outcome,
        error_code = p_error_code,
        error_subcode = p_error_subcode,
        http_status = p_http_status,
        finished_at = now()
    where t.id = p_attempt_id and t.followup_id = p_id;

    update public.automation_comments c
    set gate_status = coalesce(p_gate_status, c.gate_status),
        gate_prompts = c.gate_prompts + case when p_count_reminder then 1 else 0 end
    where c.id = job.automation_comment_id;

    if p_cooldown_until is not null then
        insert into public.automation_accounts (account_id, user_id, cooldown_until, cooldown_reason)
        values (job.account_id, job.user_id, p_cooldown_until, p_cooldown_reason)
        on conflict (account_id) do update
        set cooldown_until = greatest(coalesce(public.automation_accounts.cooldown_until, excluded.cooldown_until), excluded.cooldown_until),
            cooldown_reason = excluded.cooldown_reason;
    end if;

    if p_pause_reason is not null then
        insert into public.automation_accounts (account_id, user_id, paused, paused_reason)
        values (job.account_id, job.user_id, true, p_pause_reason)
        on conflict (account_id) do update set paused = true, paused_reason = excluded.paused_reason;
    end if;
    return true;
end;
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.finish_automation_followup(text, text, text, text, text, text, text, integer, integer, integer, timestamptz, timestamptz, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.finish_automation_followup(text, text, text, text, text, text, text, integer, integer, integer, timestamptz, timestamptz, text, text, text, boolean) to service_role;
-- creates automation_review_candidates, which lists replies of unknown outcome that are ready to be looked for on Instagram
create or replace function public.automation_review_candidates(
    p_limit integer,
    p_settle_seconds integer,
    p_max_checks integer,
    p_recheck_seconds integer
)
returns table (
    id text,
    ig_user_id text,
    from_id text,
    started_at timestamptz,
    message_digest text,
    access_token text,
    review_checks integer
)
language sql
stable
set search_path = ''
as $$
    select c.id, c.ig_user_id, c.from_id, t.started_at, t.message_digest, a.data ->> 'accessToken', c.review_checks
    from public.automation_comments c
    join lateral (
        select t.started_at, t.message_digest
        from public.automation_attempts t
        where t.automation_comment_id = c.id and t.kind = 'private_reply' and t.outcome = 'ambiguous'
        order by t.started_at desc
        limit 1
    ) t on true
    join public.accounts a on a.id = c.account_id and a.user_id = c.user_id
    where c.status = 'needs_review'
        and c.status_reason in ('no_answer', 'interrupted')
        and c.from_id is not null
        and c.review_checks < p_max_checks
        and (c.review_checked_at is null or c.review_checked_at < now() - make_interval(secs => p_recheck_seconds))
        and t.started_at < now() - make_interval(secs => p_settle_seconds)
    order by c.review_checked_at nulls first, c.updated_at
    limit p_limit;
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.automation_review_candidates(integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.automation_review_candidates(integer, integer, integer, integer) to service_role;
-- creates record_automation_review, which saves whether a reply of unknown outcome was found on Instagram
create or replace function public.record_automation_review(
    p_id text,
    p_found boolean,
    p_message_id text default null,
    p_sent_at timestamptz default null,
    p_note text default null
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
    job public.automation_comments%rowtype;
begin
    if p_found then
        update public.automation_comments c
        set status = 'accepted',
            status_reason = 'confirmed',
            error_message = null,
            message_id = coalesce(p_message_id, c.message_id),
            accepted_at = coalesce(p_sent_at, now()),
            recipient_id = coalesce(c.recipient_id, c.from_id),
            gate_status = case
                when (select r.require_follow from public.automation_rules r where r.id = c.rule_id) then 'awaiting_reply'
                else c.gate_status
            end,
            review_checks = c.review_checks + 1,
            review_checked_at = now()
        where c.id = p_id and c.status = 'needs_review' and c.status_reason in ('no_answer', 'interrupted')
        returning * into job;
        if not found then
            return false;
        end if;
        update public.automation_attempts t
        set outcome = 'accepted', finished_at = coalesce(t.finished_at, now())
        where t.automation_comment_id = p_id and t.kind = 'private_reply' and t.outcome = 'ambiguous';
        return true;
    end if;

    update public.automation_comments c
    set review_checks = c.review_checks + 1,
        review_checked_at = now(),
        error_message = coalesce(left(p_note, 500), c.error_message)
    where c.id = p_id and c.status = 'needs_review' and c.status_reason in ('no_answer', 'interrupted');
    return found;
end;
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.record_automation_review(text, boolean, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.record_automation_review(text, boolean, text, timestamptz, text) to service_role;
-- creates expire_automation_jobs, which marks replies and follow-ups whose time ran out as expired
create or replace function public.expire_automation_jobs(p_limit integer)
returns jsonb
language sql
set search_path = ''
as $$
    with due_comments as (
        select c.id
        from public.automation_comments c
        where c.status in ('queued', 'retry_wait') and c.expires_at <= now()
        limit p_limit
        for update skip locked
    ),
    expired_comments as (
        update public.automation_comments c
        set status = 'expired',
            status_reason = 'expired',
            error_message = 'The 7 days in which Instagram allows a private reply to this comment ran out.',
            next_attempt_at = null,
            claimed_at = null
        from due_comments
        where c.id = due_comments.id
        returning c.id
    ),
    due_followups as (
        select f.id
        from public.automation_followups f
        where f.status in ('queued', 'retry_wait') and f.window_expires_at <= now()
        limit p_limit
        for update skip locked
    ),
    expired_followups as (
        update public.automation_followups f
        set status = 'expired',
            status_reason = 'expired',
            error_message = 'The 24 hours in which Instagram allows a message after the person''s reply ran out.',
            next_attempt_at = null,
            claimed_at = null
        from due_followups
        where f.id = due_followups.id
        returning f.id
    )
    select jsonb_build_object(
        'comments', (select count(*) from expired_comments),
        'followups', (select count(*) from expired_followups)
    );
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.expire_automation_jobs(integer) from public, anon, authenticated;
grant execute on function public.expire_automation_jobs(integer) to service_role;
-- creates purge_automation_comments, which deletes old comments in small batches
create or replace function public.purge_automation_comments(p_before timestamptz, p_limit integer)
returns integer
language sql
set search_path = ''
as $$
    with doomed as (
        select c.id
        from public.automation_comments c
        where c.created_at < p_before
        order by c.created_at
        limit p_limit
        for update skip locked
    ),
    deleted as (
        delete from public.automation_comments c
        using doomed
        where c.id = doomed.id
        returning c.id
    )
    select count(*)::integer from deleted;
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.purge_automation_comments(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.purge_automation_comments(timestamptz, integer) to service_role;
-- creates automation_queue_health, which counts what is waiting, stuck or needs review in the reply queue
create or replace function public.automation_queue_health(p_lease_seconds integer)
returns jsonb
language sql
stable
set search_path = ''
as $$
    select jsonb_build_object(
        'due', (
            select count(*) from public.automation_comments c
            where c.status in ('queued', 'retry_wait') and c.next_attempt_at <= now()
        ),
        'oldest_due_at', (
            select min(c.next_attempt_at) from public.automation_comments c
            where c.status in ('queued', 'retry_wait') and c.next_attempt_at <= now()
        ),
        'waiting', (
            select count(*) from public.automation_comments c where c.status in ('queued', 'retry_wait')
        ),
        'stale', (
            select count(*) from public.automation_comments c
            where c.status in ('processing', 'sending') and c.claimed_at < now() - make_interval(secs => p_lease_seconds)
        ),
        'needs_review', (
            select count(*) from public.automation_comments c where c.status = 'needs_review'
        ),
        'followups_due', (
            select count(*) from public.automation_followups f
            where f.status in ('queued', 'retry_wait') and f.next_attempt_at <= now()
        ),
        'paused_accounts', (
            select count(*) from public.automation_accounts a where a.paused
        ),
        'limited_accounts', (
            select count(*) from public.automation_accounts a
            where a.cooldown_until > now() or a.limited_until > now()
        )
    );
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.automation_queue_health(integer) from public, anon, authenticated;
grant execute on function public.automation_queue_health(integer) to service_role;
-- lets a rule send a private reply, a public reply under the comment, or both
alter table public.automation_rules
    drop constraint automation_rules_reply_text_check,
    add column private_reply_enabled boolean not null default true,
    add column public_reply_enabled boolean not null default false,
    add column public_reply_texts text[] not null default '{}',
    -- a rule without the private reply keeps an empty reply text
    add constraint automation_rules_reply_text_check check (
        char_length(reply_text) between 1 and 1000 or (not private_reply_enabled and reply_text = '')
    ),
    add constraint automation_rules_actions_check check (private_reply_enabled or public_reply_enabled),
    add constraint automation_rules_public_reply_texts_check check (
        cardinality(public_reply_texts) <= 5 and (not public_reply_enabled or cardinality(public_reply_texts) >= 1)
    ),
    -- the followers-only wait starts with the private reply
    add constraint automation_rules_follow_private_check check (not require_follow or private_reply_enabled);
-- adds a separate cooldown and hourly limit for public replies to automation_accounts
alter table public.automation_accounts
    add column public_cooldown_until timestamptz,
    add column public_cooldown_reason text,
    add column public_limited_until timestamptz,
    add constraint automation_accounts_public_cooldown_reason_check check (public_cooldown_reason is null or char_length(public_cooldown_reason) <= 200);
-- creates automation_public_replies, which holds the public reply under each matched comment as its own job
create table public.automation_public_replies (
    id text primary key,
    user_id uuid not null references auth.users (id) on delete cascade,
    account_id text not null,
    automation_comment_id text not null references public.automation_comments (id) on delete cascade,
    rule_id text references public.automation_rules (id) on delete set null,
    ig_user_id text not null,
    -- the comment answered, with its post and author for the limit of one public reply per person and post a day
    comment_id text not null,
    media_id text,
    from_id text,
    -- picked from the rule's texts when the comment arrived, so every try and every check sees the same words
    reply_text text not null,
    status text not null,
    status_reason text,
    error_message text,
    attempts integer not null default 0,
    next_attempt_at timestamptz,
    claimed_at timestamptz,
    -- the id Instagram gave the reply
    reply_id text,
    accepted_at timestamptz,
    -- checks of a reply whose outcome was unknown against the comment's replies on Instagram
    review_checks integer not null default 0,
    review_checked_at timestamptz,
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint automation_public_replies_account_fkey foreign key (account_id, user_id)
        references public.accounts (id, user_id) on delete cascade,
    constraint automation_public_replies_comment_key unique (automation_comment_id),
    constraint automation_public_replies_status_check check (status in (
        'queued', 'processing', 'retry_wait', 'sending', 'accepted', 'failed', 'needs_review', 'skipped', 'expired'
    )),
    constraint automation_public_replies_waiting_check check (status not in ('queued', 'retry_wait') or next_attempt_at is not null),
    constraint automation_public_replies_attempts_check check (attempts >= 0),
    constraint automation_public_replies_review_checks_check check (review_checks >= 0),
    -- Instagram comments are at most 2,200 characters
    constraint automation_public_replies_reply_text_check check (char_length(reply_text) between 1 and 2200),
    constraint automation_public_replies_error_message_check check (error_message is null or char_length(error_message) <= 500)
);
-- turns on row level security and removes browser access to automation_public_replies
alter table public.automation_public_replies enable row level security;
revoke all on table public.automation_public_replies from anon, authenticated;
-- adds the trigger that keeps updated_at current on automation_public_replies
create trigger automation_public_replies_set_updated_at before update on public.automation_public_replies
    for each row execute function public.set_updated_at();
-- adds an index that finds each account's public replies waiting to be posted
create index automation_public_replies_due_account_idx on public.automation_public_replies (account_id, next_attempt_at) where status in ('queued', 'retry_wait');
-- adds an index that finds public replies held by a run that stopped
create index automation_public_replies_claimed_idx on public.automation_public_replies (claimed_at) where status in ('processing', 'sending');
-- adds an index that finds public replies whose outcome is unknown
create index automation_public_replies_needs_review_idx on public.automation_public_replies (review_checked_at nulls first, updated_at) where status = 'needs_review';
-- adds an index that checks whether a person already got a public reply on a post
create index automation_public_replies_recipient_idx on public.automation_public_replies (account_id, from_id, media_id, created_at)
    where status in ('sending', 'accepted', 'needs_review');
-- adds an index that counts a user's public replies for a period
create index automation_public_replies_user_created_idx on public.automation_public_replies (user_id, created_at);
-- lets automation_attempts record public replies as their own kind
alter table public.automation_attempts
    add column public_reply_id text references public.automation_public_replies (id) on delete cascade,
    drop constraint automation_attempts_kind_check,
    add constraint automation_attempts_kind_check check (kind in ('private_reply', 'followup', 'public_reply')),
    add constraint automation_attempts_public_reply_check check ((kind = 'public_reply') = (public_reply_id is not null));
-- adds an index that finds the attempts of one public reply
create index automation_attempts_public_reply_idx on public.automation_attempts (public_reply_id) where public_reply_id is not null;
-- replaces automation_rules_for_ig_user so it also returns each rule's public reply settings
drop function if exists public.automation_rules_for_ig_user(text);
create or replace function public.automation_rules_for_ig_user(p_ig_user_id text)
returns table (
    id text,
    user_id uuid,
    account_id text,
    keywords text[],
    match_mode text,
    case_sensitive boolean,
    media_ids text[],
    created_at timestamptz,
    private_reply_enabled boolean,
    public_reply_enabled boolean,
    public_reply_texts text[]
)
language sql
stable
set search_path = ''
as $$
    select r.id, r.user_id, r.account_id, r.keywords, r.match_mode, r.case_sensitive, r.media_ids, r.created_at,
        r.private_reply_enabled, r.public_reply_enabled, r.public_reply_texts
    from public.accounts a
    join public.automation_rules r on r.account_id = a.id and r.user_id = a.user_id
    where a.platform = 'instagram'
        and a.data ->> 'igUserId' = p_ig_user_id
        and r.enabled
    order by a.created_at, a.id, r.created_at, r.id;
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.automation_rules_for_ig_user(text) from public, anon, authenticated;
grant execute on function public.automation_rules_for_ig_user(text) to service_role;
-- creates store_automation_comments, which saves a webhook's comments and their public replies together
create or replace function public.store_automation_comments(p_comments jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
    stored jsonb;
    replies jsonb;
begin
    with inserted as (
        insert into public.automation_comments (
            id, user_id, account_id, rule_id, ig_user_id, comment_id, media_id, from_id, from_username, text, status,
            status_reason, next_attempt_at, notified_at, expires_at
        )
        select x.id, x.user_id, x.account_id, x.rule_id, x.ig_user_id, x.comment_id, x.media_id, x.from_id, x.from_username,
            x.text, x.status, x.status_reason, x.next_attempt_at, x.notified_at, x.expires_at
        from jsonb_to_recordset(p_comments) as x(
            id text, user_id uuid, account_id text, rule_id text, ig_user_id text, comment_id text, media_id text,
            from_id text, from_username text, text text, status text, status_reason text, next_attempt_at timestamptz,
            notified_at timestamptz, expires_at timestamptz
        )
        on conflict (ig_user_id, comment_id) do nothing
        returning automation_comments.id, automation_comments.status
    )
    select coalesce(jsonb_agg(jsonb_build_object('id', inserted.id, 'status', inserted.status)), '[]'::jsonb) into stored from inserted;

    -- joined to the comment as stored, new or kept from an earlier copy, and only while the same rule answers it
    with inserted as (
        insert into public.automation_public_replies (
            id, user_id, account_id, automation_comment_id, rule_id, ig_user_id, comment_id, media_id, from_id, reply_text,
            status, next_attempt_at, expires_at
        )
        select x.public_reply_id, c.user_id, c.account_id, c.id, c.rule_id, c.ig_user_id, c.comment_id, c.media_id, c.from_id,
            x.public_reply_text, 'queued', now(), c.expires_at
        from jsonb_to_recordset(p_comments) as x(
            ig_user_id text, comment_id text, rule_id text, public_reply_id text, public_reply_text text
        )
        join public.automation_comments c on c.ig_user_id = x.ig_user_id and c.comment_id = x.comment_id and c.rule_id = x.rule_id
        where x.public_reply_id is not null and x.public_reply_text is not null
        on conflict (automation_comment_id) do nothing
        returning automation_public_replies.id
    )
    select coalesce(jsonb_agg(inserted.id), '[]'::jsonb) into replies from inserted;

    return jsonb_build_object('comments', stored, 'public_replies', replies);
end;
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.store_automation_comments(jsonb) from public, anon, authenticated;
grant execute on function public.store_automation_comments(jsonb) to service_role;
-- creates claim_automation_public_replies, which hands a run the public replies that are due to be posted
create or replace function public.claim_automation_public_replies(
    p_limit integer,
    p_per_account integer,
    p_lease_seconds integer,
    p_ids text[] default null
)
returns table (
    id text,
    user_id uuid,
    account_id text,
    rule_id text,
    ig_user_id text,
    comment_id text,
    attempts integer,
    expires_at timestamptz,
    reply_text text,
    rule_enabled boolean,
    access_token text
)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
    stale_before timestamptz := now() - make_interval(secs => p_lease_seconds);
begin
    -- a reply whose run stopped while sending may be on Instagram; the review reads the comment's replies to find out
    with interrupted as (
        update public.automation_public_replies p
        set status = 'needs_review',
            status_reason = 'interrupted',
            claimed_at = null,
            error_message = 'The run stopped while this public reply was being sent. Twiligent checks the comment''s replies on Instagram.'
        where p.status = 'sending' and p.claimed_at < stale_before
        returning p.id
    )
    update public.automation_attempts t
    set outcome = 'ambiguous', finished_at = now()
    where t.public_reply_id in (select interrupted.id from interrupted) and t.outcome = 'sending';

    return query
    with recursive waiting_accounts as (
        -- one index probe per account instead of reading every waiting reply
        (select p.account_id
        from public.automation_public_replies p
        where p.status in ('queued', 'retry_wait') and p_ids is null
        order by p.account_id
        limit 1)
        union all
        select (select p.account_id
            from public.automation_public_replies p
            where p.status in ('queued', 'retry_wait') and p.account_id > w.account_id
            order by p.account_id
            limit 1)
        from waiting_accounts w
        where w.account_id is not null
    ),
    due_accounts as (
        select w.account_id from waiting_accounts w where w.account_id is not null
        union
        select p.account_id from public.automation_public_replies p where p.id = any (p_ids)
        union
        select p.account_id
        from public.automation_public_replies p
        where p.status = 'processing' and p.claimed_at < stale_before and (p_ids is null or p.id = any (p_ids))
    ),
    open_accounts as (
        select d.account_id
        from due_accounts d
        left join public.automation_accounts s on s.account_id = d.account_id
        where s.account_id is null
            or (not s.paused
                and (s.public_cooldown_until is null or s.public_cooldown_until <= now())
                and (s.public_limited_until is null or s.public_limited_until <= now()))
    ),
    -- locked as they are read, so runs at the same moment take different replies
    candidates as (
        select x.id, x.account_id, x.next_attempt_at as due_at
        from open_accounts o
        cross join lateral (
            select p.id, p.account_id, p.next_attempt_at
            from public.automation_public_replies p
            where p.account_id = o.account_id and p.status in ('queued', 'retry_wait') and p.next_attempt_at <= now()
                and (p_ids is null or p.id = any (p_ids))
            order by p.next_attempt_at
            limit p_per_account
            for update of p skip locked
        ) x
        union all
        select x.id, x.account_id, x.claimed_at as due_at
        from open_accounts o
        cross join lateral (
            select p.id, p.account_id, p.claimed_at
            from public.automation_public_replies p
            where p.account_id = o.account_id and p.status = 'processing' and p.claimed_at < stale_before
                and (p_ids is null or p.id = any (p_ids))
            order by p.claimed_at
            limit p_per_account
            for update of p skip locked
        ) x
    ),
    picked as (
        select ranked.id
        from (
            select candidates.id, candidates.due_at,
                row_number() over (partition by candidates.account_id order by candidates.due_at, candidates.id) as place
            from candidates
        ) ranked
        order by ranked.place, ranked.due_at
        limit p_limit
    ),
    claimed as (
        update public.automation_public_replies p
        set status = 'processing', claimed_at = now()
        from picked
        where p.id = picked.id
        returning p.id, p.user_id, p.account_id, p.rule_id, p.ig_user_id, p.comment_id, p.attempts, p.expires_at, p.reply_text
    )
    select claimed.id, claimed.user_id, claimed.account_id, claimed.rule_id, claimed.ig_user_id, claimed.comment_id,
        claimed.attempts, claimed.expires_at, claimed.reply_text,
        coalesce(r.enabled and r.public_reply_enabled, false), a.data ->> 'accessToken'
    from claimed
    left join public.automation_rules r on r.id = claimed.rule_id
    left join public.accounts a on a.id = claimed.account_id and a.user_id = claimed.user_id;
end;
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.claim_automation_public_replies(integer, integer, integer, text[]) from public, anon, authenticated;
grant execute on function public.claim_automation_public_replies(integer, integer, integer, text[]) to service_role;
-- creates reserve_automation_public_reply, which checks the limits and records an attempt before a public reply is posted
create or replace function public.reserve_automation_public_reply(
    p_id text,
    p_attempt_id text,
    p_account_limit integer,
    p_message_digest text default null
)
returns table (outcome text, retry_at timestamptz)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
    job public.automation_public_replies%rowtype;
    controls public.automation_accounts%rowtype;
    free_at timestamptz;
begin
    -- one public reservation at a time across every Worker; private replies take another lock, so neither waits on the other
    perform pg_advisory_xact_lock(hashtext('reserve_automation_public_reply'));

    select * into job from public.automation_public_replies p where p.id = p_id and p.status = 'processing' for update;
    if not found then
        return query select 'gone'::text, null::timestamptz;
        return;
    end if;

    select * into controls from public.automation_accounts a where a.account_id = job.account_id;
    if controls.paused then
        return query select 'paused'::text, null::timestamptz;
        return;
    end if;
    if controls.public_cooldown_until > now() then
        return query select 'cooldown'::text, controls.public_cooldown_until;
        return;
    end if;

    -- one public reply per person and post a day, however often they comment; it also ends a loop with another
    -- account's automation answering every reply
    if job.from_id is not null and exists (
        select 1 from public.automation_public_replies p
        where p.account_id = job.account_id and p.from_id = job.from_id and p.media_id is not distinct from job.media_id
            and p.id <> job.id and p.status in ('sending', 'accepted', 'needs_review') and p.created_at > now() - interval '1 day'
    ) then
        return query select 'recipient_limit'::text, null::timestamptz;
        return;
    end if;

    -- when the account is full, a reply frees up an hour after the oldest one in the window
    select case when count(*) >= p_account_limit then min(t.started_at) + interval '1 hour' end into free_at
    from public.automation_attempts t
    where t.account_id = job.account_id and t.kind = 'public_reply' and t.started_at > now() - interval '1 hour';
    if free_at is not null then
        insert into public.automation_accounts (account_id, user_id, public_limited_until)
        values (job.account_id, job.user_id, free_at)
        on conflict (account_id) do update set public_limited_until = excluded.public_limited_until;
        return query select 'account_limit'::text, free_at;
        return;
    end if;

    update public.automation_public_replies p
    set status = 'sending', claimed_at = now(), attempts = p.attempts + 1
    where p.id = p_id;
    insert into public.automation_attempts (id, user_id, account_id, automation_comment_id, rule_id, recipient_id, kind, public_reply_id, message_digest)
    values (p_attempt_id, job.user_id, job.account_id, job.automation_comment_id, job.rule_id, job.from_id, 'public_reply', job.id, p_message_digest);
    return query select 'ok'::text, null::timestamptz;
end;
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.reserve_automation_public_reply(text, text, integer, text) from public, anon, authenticated;
grant execute on function public.reserve_automation_public_reply(text, text, integer, text) to service_role;
-- creates finish_automation_public_reply, which saves what Instagram answered to a public reply
create or replace function public.finish_automation_public_reply(
    p_id text,
    p_attempt_id text,
    p_status text,
    p_outcome text,
    p_reason text default null,
    p_error_message text default null,
    p_reply_id text default null,
    p_error_code integer default null,
    p_error_subcode integer default null,
    p_http_status integer default null,
    p_next_attempt_at timestamptz default null,
    p_cooldown_until timestamptz default null,
    p_cooldown_reason text default null,
    p_pause_reason text default null
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
    job public.automation_public_replies%rowtype;
begin
    update public.automation_public_replies p
    set status = p_status,
        status_reason = p_reason,
        error_message = p_error_message,
        reply_id = coalesce(p_reply_id, p.reply_id),
        accepted_at = case when p_status = 'accepted' then now() else p.accepted_at end,
        next_attempt_at = p_next_attempt_at,
        claimed_at = null
    where p.id = p_id and (p.status = 'sending' or (p.status = 'needs_review' and p.status_reason = 'interrupted'))
    returning * into job;
    -- a reply already settled keeps the attempt that settled it
    if not found then
        return false;
    end if;

    update public.automation_attempts t
    set outcome = p_outcome,
        error_code = p_error_code,
        error_subcode = p_error_subcode,
        http_status = p_http_status,
        finished_at = now()
    where t.id = p_attempt_id and t.public_reply_id = p_id;

    if p_cooldown_until is not null then
        insert into public.automation_accounts (account_id, user_id, public_cooldown_until, public_cooldown_reason)
        values (job.account_id, job.user_id, p_cooldown_until, p_cooldown_reason)
        on conflict (account_id) do update
        set public_cooldown_until = greatest(coalesce(public.automation_accounts.public_cooldown_until, excluded.public_cooldown_until), excluded.public_cooldown_until),
            public_cooldown_reason = excluded.public_cooldown_reason;
    end if;

    if p_pause_reason is not null then
        insert into public.automation_accounts (account_id, user_id, paused, paused_reason)
        values (job.account_id, job.user_id, true, p_pause_reason)
        on conflict (account_id) do update set paused = true, paused_reason = excluded.paused_reason;
    end if;
    return true;
end;
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.finish_automation_public_reply(text, text, text, text, text, text, text, integer, integer, integer, timestamptz, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.finish_automation_public_reply(text, text, text, text, text, text, text, integer, integer, integer, timestamptz, timestamptz, text, text) to service_role;
-- creates automation_public_review_candidates, which lists public replies of unknown outcome that are ready to be looked for
create or replace function public.automation_public_review_candidates(
    p_limit integer,
    p_settle_seconds integer,
    p_max_checks integer,
    p_recheck_seconds integer
)
returns table (
    id text,
    ig_user_id text,
    comment_id text,
    started_at timestamptz,
    message_digest text,
    access_token text,
    review_checks integer,
    ambiguous_attempts integer
)
language sql
stable
set search_path = ''
as $$
    select p.id, p.ig_user_id, p.comment_id, t.started_at, t.message_digest, a.data ->> 'accessToken', p.review_checks,
        (select count(*)::integer from public.automation_attempts x where x.public_reply_id = p.id and x.outcome = 'ambiguous')
    from public.automation_public_replies p
    join lateral (
        select t.started_at, t.message_digest
        from public.automation_attempts t
        where t.public_reply_id = p.id and t.outcome = 'ambiguous'
        order by t.started_at desc
        limit 1
    ) t on true
    join public.accounts a on a.id = p.account_id and a.user_id = p.user_id
    where p.status = 'needs_review'
        and p.status_reason in ('no_answer', 'interrupted')
        and p.review_checks < p_max_checks
        and (p.review_checked_at is null or p.review_checked_at < now() - make_interval(secs => p_recheck_seconds))
        and t.started_at < now() - make_interval(secs => p_settle_seconds)
    order by p.review_checked_at nulls first, p.updated_at
    limit p_limit;
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.automation_public_review_candidates(integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.automation_public_review_candidates(integer, integer, integer, integer) to service_role;
-- creates record_automation_public_review, which saves whether a public reply of unknown outcome was found
create or replace function public.record_automation_public_review(
    p_id text,
    p_found boolean,
    p_reply_id text default null,
    p_sent_at timestamptz default null,
    p_note text default null,
    p_resend boolean default false
)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
    if p_found then
        update public.automation_public_replies p
        set status = 'accepted',
            status_reason = 'confirmed',
            error_message = null,
            reply_id = coalesce(p_reply_id, p.reply_id),
            accepted_at = coalesce(p_sent_at, now()),
            review_checks = p.review_checks + 1,
            review_checked_at = now()
        where p.id = p_id and p.status = 'needs_review' and p.status_reason in ('no_answer', 'interrupted');
        if not found then
            return false;
        end if;
        update public.automation_attempts t
        set outcome = 'accepted', finished_at = coalesce(t.finished_at, now())
        where t.id = (
            select x.id from public.automation_attempts x
            where x.public_reply_id = p_id and x.outcome = 'ambiguous'
            order by x.started_at desc
            limit 1
        );
        return true;
    end if;

    if p_resend then
        update public.automation_public_replies p
        set status = 'queued',
            status_reason = 'resend_after_check',
            error_message = null,
            next_attempt_at = now(),
            claimed_at = null,
            review_checks = 0,
            review_checked_at = null
        where p.id = p_id and p.status = 'needs_review' and p.status_reason in ('no_answer', 'interrupted');
        return found;
    end if;

    update public.automation_public_replies p
    set review_checks = p.review_checks + 1,
        review_checked_at = now(),
        error_message = coalesce(left(p_note, 500), p.error_message)
    where p.id = p_id and p.status = 'needs_review' and p.status_reason in ('no_answer', 'interrupted');
    return found;
end;
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.record_automation_public_review(text, boolean, text, timestamptz, text, boolean) from public, anon, authenticated;
grant execute on function public.record_automation_public_review(text, boolean, text, timestamptz, text, boolean) to service_role;
-- replaces expire_automation_jobs so it also expires public replies
create or replace function public.expire_automation_jobs(p_limit integer)
returns jsonb
language sql
set search_path = ''
as $$
    with due_comments as (
        select c.id
        from public.automation_comments c
        where c.status in ('queued', 'retry_wait') and c.expires_at <= now()
        limit p_limit
        for update skip locked
    ),
    expired_comments as (
        update public.automation_comments c
        set status = 'expired',
            status_reason = 'expired',
            error_message = 'The 7 days in which Instagram allows a private reply to this comment ran out.',
            next_attempt_at = null,
            claimed_at = null
        from due_comments
        where c.id = due_comments.id
        returning c.id
    ),
    due_followups as (
        select f.id
        from public.automation_followups f
        where f.status in ('queued', 'retry_wait') and f.window_expires_at <= now()
        limit p_limit
        for update skip locked
    ),
    expired_followups as (
        update public.automation_followups f
        set status = 'expired',
            status_reason = 'expired',
            error_message = 'The 24 hours in which Instagram allows a message after the person''s reply ran out.',
            next_attempt_at = null,
            claimed_at = null
        from due_followups
        where f.id = due_followups.id
        returning f.id
    ),
    due_public_replies as (
        select p.id
        from public.automation_public_replies p
        where p.status in ('queued', 'retry_wait') and p.expires_at <= now()
        limit p_limit
        for update skip locked
    ),
    expired_public_replies as (
        update public.automation_public_replies p
        set status = 'expired',
            status_reason = 'expired',
            error_message = 'This public reply waited 7 days without going out, so Twiligent stopped trying.',
            next_attempt_at = null,
            claimed_at = null
        from due_public_replies
        where p.id = due_public_replies.id
        returning p.id
    )
    select jsonb_build_object(
        'comments', (select count(*) from expired_comments),
        'followups', (select count(*) from expired_followups),
        'public_replies', (select count(*) from expired_public_replies)
    );
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.expire_automation_jobs(integer) from public, anon, authenticated;
grant execute on function public.expire_automation_jobs(integer) to service_role;
-- replaces automation_queue_health so it also counts public replies
create or replace function public.automation_queue_health(p_lease_seconds integer)
returns jsonb
language sql
stable
set search_path = ''
as $$
    select jsonb_build_object(
        'due', (
            select count(*) from public.automation_comments c
            where c.status in ('queued', 'retry_wait') and c.next_attempt_at <= now()
        ),
        'oldest_due_at', (
            select min(c.next_attempt_at) from public.automation_comments c
            where c.status in ('queued', 'retry_wait') and c.next_attempt_at <= now()
        ),
        'waiting', (
            select count(*) from public.automation_comments c where c.status in ('queued', 'retry_wait')
        ),
        'stale', (
            select count(*) from public.automation_comments c
            where c.status in ('processing', 'sending') and c.claimed_at < now() - make_interval(secs => p_lease_seconds)
        ),
        'needs_review', (
            select count(*) from public.automation_comments c where c.status = 'needs_review'
        ),
        'followups_due', (
            select count(*) from public.automation_followups f
            where f.status in ('queued', 'retry_wait') and f.next_attempt_at <= now()
        ),
        'public_due', (
            select count(*) from public.automation_public_replies p
            where p.status in ('queued', 'retry_wait') and p.next_attempt_at <= now()
        ),
        'public_oldest_due_at', (
            select min(p.next_attempt_at) from public.automation_public_replies p
            where p.status in ('queued', 'retry_wait') and p.next_attempt_at <= now()
        ),
        'public_stale', (
            select count(*) from public.automation_public_replies p
            where p.status in ('processing', 'sending') and p.claimed_at < now() - make_interval(secs => p_lease_seconds)
        ),
        'public_needs_review', (
            select count(*) from public.automation_public_replies p where p.status = 'needs_review'
        ),
        'paused_accounts', (
            select count(*) from public.automation_accounts a where a.paused
        ),
        'limited_accounts', (
            select count(*) from public.automation_accounts a
            where a.cooldown_until > now() or a.limited_until > now()
                or a.public_cooldown_until > now() or a.public_limited_until > now()
        )
    );
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.automation_queue_health(integer) from public, anon, authenticated;
grant execute on function public.automation_queue_health(integer) to service_role;
-- replaces automation_stats so it also counts public replies
create or replace function public.automation_stats(
    p_user_id uuid,
    p_from timestamptz,
    p_to timestamptz,
    p_account_id text default null,
    p_rule_id text default null
)
returns jsonb
language sql
stable
set search_path = ''
as $$
    select jsonb_build_object(
        'comments', coalesce((
            select jsonb_object_agg(counted.status, counted.total)
            from (
                select c.status, count(*) as total
                from public.automation_comments c
                where c.user_id = p_user_id
                    and c.created_at >= p_from and c.created_at < p_to
                    and (p_account_id is null or c.account_id = p_account_id)
                    and (p_rule_id is null or c.rule_id = p_rule_id)
                group by c.status
            ) counted
        ), '{}'::jsonb),
        'public_replies', coalesce((
            select jsonb_object_agg(counted.status, counted.total)
            from (
                select p.status, count(*) as total
                from public.automation_public_replies p
                where p.user_id = p_user_id
                    and p.created_at >= p_from and p.created_at < p_to
                    and (p_account_id is null or p.account_id = p_account_id)
                    and (p_rule_id is null or p.rule_id = p_rule_id)
                group by p.status
            ) counted
        ), '{}'::jsonb),
        'attempts', coalesce((
            select jsonb_object_agg(counted.outcome, counted.total)
            from (
                select t.outcome, count(*) as total
                from public.automation_attempts t
                where t.user_id = p_user_id
                    and t.started_at >= p_from and t.started_at < p_to
                    and (p_account_id is null or t.account_id = p_account_id)
                    and (p_rule_id is null or t.rule_id = p_rule_id)
                group by t.outcome
            ) counted
        ), '{}'::jsonb)
    );
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.automation_stats(uuid, timestamptz, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.automation_stats(uuid, timestamptz, timestamptz, text, text) to service_role;
-- replaces claim_automation_comments so a rule whose private reply was turned off sends no private reply
create or replace function public.claim_automation_comments(
    p_limit integer,
    p_per_account integer,
    p_lease_seconds integer,
    p_ids text[] default null
)
returns table (
    id text,
    user_id uuid,
    account_id text,
    rule_id text,
    ig_user_id text,
    comment_id text,
    from_id text,
    attempts integer,
    expires_at timestamptz,
    rule_enabled boolean,
    reply_text text,
    link_url text,
    access_token text,
    require_follow boolean,
    follow_prompt_text text
)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
    stale_before timestamptz := now() - make_interval(secs => p_lease_seconds);
begin
    -- a send whose run stopped may have reached Instagram, so a person decides instead of a second send
    with interrupted as (
        update public.automation_comments c
        set status = 'needs_review',
            status_reason = 'interrupted',
            claimed_at = null,
            error_message = 'The run stopped while this reply was being sent. Check the conversation on Instagram before you retry.'
        where c.status = 'sending' and c.claimed_at < stale_before
        returning c.id
    )
    update public.automation_attempts t
    set outcome = 'ambiguous', finished_at = now()
    where t.automation_comment_id in (select interrupted.id from interrupted) and t.outcome = 'sending';

    return query
    with recursive waiting_accounts as (
        -- one index probe per account instead of reading every waiting job, however long one account's queue is
        (select c.account_id
        from public.automation_comments c
        where c.status in ('queued', 'retry_wait') and p_ids is null
        order by c.account_id
        limit 1)
        union all
        select (select c.account_id
            from public.automation_comments c
            where c.status in ('queued', 'retry_wait') and c.account_id > w.account_id
            order by c.account_id
            limit 1)
        from waiting_accounts w
        where w.account_id is not null
    ),
    due_accounts as (
        select w.account_id from waiting_accounts w where w.account_id is not null
        union
        select c.account_id from public.automation_comments c where c.id = any (p_ids)
        union
        select c.account_id
        from public.automation_comments c
        where c.status = 'processing' and c.claimed_at < stale_before and (p_ids is null or c.id = any (p_ids))
    ),
    open_accounts as (
        select d.account_id
        from due_accounts d
        left join public.automation_accounts s on s.account_id = d.account_id
        where s.account_id is null
            or (not s.paused
                and (s.cooldown_until is null or s.cooldown_until <= now())
                and (s.limited_until is null or s.limited_until <= now()))
    ),
    -- each account's oldest due jobs, locked as they are read: a job another run holds is skipped, so runs at the
    -- same moment take the next jobs instead of the same ones
    candidates as (
        select x.id, x.account_id, x.next_attempt_at as due_at
        from open_accounts o
        cross join lateral (
            select c.id, c.account_id, c.next_attempt_at
            from public.automation_comments c
            where c.account_id = o.account_id and c.status in ('queued', 'retry_wait') and c.next_attempt_at <= now()
                and (p_ids is null or c.id = any (p_ids))
            order by c.next_attempt_at
            limit p_per_account
            for update of c skip locked
        ) x
        union all
        select x.id, x.account_id, x.claimed_at as due_at
        from open_accounts o
        cross join lateral (
            select c.id, c.account_id, c.claimed_at
            from public.automation_comments c
            where c.account_id = o.account_id and c.status = 'processing' and c.claimed_at < stale_before
                and (p_ids is null or c.id = any (p_ids))
            order by c.claimed_at
            limit p_per_account
            for update of c skip locked
        ) x
    ),
    picked as (
        select ranked.id
        from (
            select candidates.id, candidates.due_at,
                row_number() over (partition by candidates.account_id order by candidates.due_at, candidates.id) as place
            from candidates
        ) ranked
        order by ranked.place, ranked.due_at
        limit p_limit
    ),
    claimed as (
        update public.automation_comments c
        set status = 'processing', claimed_at = now()
        from picked
        where c.id = picked.id
        returning c.id, c.user_id, c.account_id, c.rule_id, c.ig_user_id, c.comment_id, c.from_id, c.attempts, c.expires_at
    )
    select claimed.id, claimed.user_id, claimed.account_id, claimed.rule_id, claimed.ig_user_id, claimed.comment_id,
        claimed.from_id, claimed.attempts, claimed.expires_at,
        coalesce(r.enabled and r.private_reply_enabled, false), r.reply_text, r.link_url, a.data ->> 'accessToken',
        coalesce(r.require_follow, false), r.follow_prompt_text
    from claimed
    left join public.automation_rules r on r.id = claimed.rule_id
    left join public.accounts a on a.id = claimed.account_id and a.user_id = claimed.user_id;
end;
$$;

-- functions in public are exposed through the Data API, so only the service role may call it
revoke execute on function public.claim_automation_comments(integer, integer, integer, text[]) from public, anon, authenticated;
grant execute on function public.claim_automation_comments(integer, integer, integer, text[]) to service_role;
-- allows each account only once per user, so two adds at the same moment store one row
create unique index if not exists accounts_identity_key on public.accounts (
    user_id,
    platform,
    (case platform when 'youtube' then data ->> 'channelId' when 'reddit' then data ->> 'username' when 'instagram' then data ->> 'igUserId' end)
);
