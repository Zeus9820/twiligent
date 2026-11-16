import { useEffect, useMemo, useRef, useState } from 'react';
import { Heart, MessageCircle, RefreshCw, Send, Sparkles, ThumbsUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import PageHeader from '@/components/PageHeader';
import SurfaceBox from '@/components/SurfaceBox';
import { EmptyState, ErrorState } from '@/components/StateViews';
import { useAppContext } from '../../context/AppContext';
import { api } from '../../services/api';
import { fmtDate, timeAgo } from '../../utils/formatters';
import type { InboxComment, InboxFilter } from '@shared/types/instagramComments.ts';

const MAX_REPLY_CHARS = 2200;

export default function InstagramComments() {
  const { accounts, showToast } = useAppContext();
  const instagramAccounts = useMemo(() => accounts.filter(account => account.platform === 'instagram'), [accounts]);
  const [accountId, setAccountId] = useState('');
  const [comments, setComments] = useState<InboxComment[]>([]);
  const [selected, setSelected] = useState<InboxComment | null>(null);
  const [filter, setFilter] = useState<InboxFilter>('needs_reply');
  const [cursor, setCursor] = useState<string | undefined>();
  const [history, setHistory] = useState<Array<string | undefined>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [reply, setReply] = useState('');
  const [search, setSearch] = useState('');
  const [loadingComments, setLoadingComments] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [hasMoreSync, setHasMoreSync] = useState(false);
  const [syncedAt, setSyncedAt] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [sending, setSending] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [syncError, setSyncError] = useState('');
  const [actionError, setActionError] = useState('');
  const activeSyncs = useRef(new Set<string>());
  const activeAccount = useRef(accountId);
  activeAccount.current = accountId;
  const activeCommentKey = useRef('');
  activeCommentKey.current = `${accountId}:${selected?.id ?? ''}`;
  const mediaId = selected?.mediaId ?? '';
  const visibleComments = comments.filter(comment => `${comment.text} ${comment.username}`.toLowerCase().includes(search.toLowerCase()));

  useEffect(() => {
    if (instagramAccounts.length && !instagramAccounts.some(account => account.id === accountId)) setAccountId(instagramAccounts[0].id);
  }, [instagramAccounts, accountId]);

  useEffect(() => {
    let live = true;
    if (!accountId) return;
    setLoadingComments(true); setLoadError('');
    api.getIGInbox(accountId, filter, cursor).then(result => {
      if (!live) return;
      setComments(result.comments); setNextCursor(result.nextCursor);
    }).catch(error => { if (live) setLoadError((error as Error).message); })
      .finally(() => { if (live) setLoadingComments(false); });
    return () => { live = false; };
  }, [accountId, filter, cursor, revision]);

  useEffect(() => { setSelected(null); setReply(''); setActionError(''); }, [accountId, filter, cursor]);

  useEffect(() => {
    if (!accountId) return;
    setHasMoreSync(false); setSyncedAt(''); setSyncError('');
    void syncBatch(accountId);
  }, [accountId]);

  async function syncBatch(id = accountId, mode: 'latest' | 'history' = 'latest') {
    if (!id || activeSyncs.current.has(id)) return;
    activeSyncs.current.add(id);
    setSyncing(true); setSyncError('');
    try {
      const result = await api.syncIGInbox(id, mode);
      if (activeAccount.current !== id) return;
      setHasMoreSync(result.hasMore); setSyncedAt(result.syncedAt);
      if (result.busy) setSyncError('Another sync is running. Try again shortly.');
      setRevision(value => value + 1);
    } catch (error) { if (activeAccount.current === id) setSyncError((error as Error).message); }
    finally { activeSyncs.current.delete(id); if (activeAccount.current === id) setSyncing(false); }
  }

  function changeFilter(value: InboxFilter) {
    setFilter(value); setCursor(undefined); setHistory([]); setSearch(''); setComments([]); setSelected(null);
  }
  function changeAccount(value: string) {
    setAccountId(value); setCursor(undefined); setHistory([]); setComments([]); setSelected(null); setReply('');
  }
  async function selectComment(comment: InboxComment) {
    setSelected(comment); setReply(''); setActionError('');
    const key = `${accountId}:${comment.id}`;
    if (comment.readAt) return;
    try {
      await api.markIGCommentRead(accountId, comment.id);
      if (activeCommentKey.current !== key) return;
      const readAt = new Date().toISOString();
      setSelected({ ...comment, readAt });
      setComments(current => filter === 'unread' ? current.filter(item => item.id !== comment.id) : current.map(item => item.id === comment.id ? { ...item, readAt } : item));
    } catch (error) { if (activeCommentKey.current === key) setActionError(`Could not mark as read: ${(error as Error).message}`); }
  }

  async function draftKindReply() {
    if (!selected || !accountId || !mediaId) return;
    const requestedKey = `${accountId}:${selected.id}`;
    setSuggesting(true); setActionError('');
    try {
      const result = await api.suggestIGCommentReply(accountId, mediaId, selected.id);
      if (activeCommentKey.current === requestedKey) setReply(result.suggestion);
    } catch (error) { if (activeCommentKey.current === requestedKey) setActionError((error as Error).message); }
    finally { setSuggesting(false); }
  }

  async function sendReply() {
    if (!selected || !accountId || !mediaId || !reply.trim() || sending) return;
    setSending(true); setActionError('');
    try {
      await api.replyToIGComment(accountId, mediaId, selected.id, reply.trim());
      if (activeCommentKey.current === `${accountId}:${selected.id}`) {
        const updated = { ...selected, repliedAt: new Date().toISOString(), replyText: reply.trim() };
        setSelected(updated);
        setComments(current => filter === 'needs_reply' || filter === 'unread' ? current.filter(item => item.id !== selected.id) : current.map(item => item.id === selected.id ? updated : item));
        setReply('');
      }
      showToast('Reply posted to Instagram');
    } catch (error) { if (activeCommentKey.current === `${accountId}:${selected.id}`) setActionError((error as Error).message); }
    finally { setSending(false); }
  }

  const accountOptions = instagramAccounts.map(account => ({ value: account.id, label: `@${account.username || account.title || 'Instagram account'}` }));

  if (!instagramAccounts.length) return <div className="flex flex-col gap-6"><PageHeader title="Instagram comments" description="Read comments on your posts and write thoughtful replies." /><EmptyState icon={<MessageCircle />} title="Connect an Instagram account first" description="Connect an Instagram professional account from Accounts to load its comments." /></div>;


  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Instagram comments"
        description="Bring the conversation into Studio. Draft replies here, review them, and choose what to post."
        actions={<Button variant="outline" disabled={syncing || !accountId} onClick={() => void syncBatch()}><RefreshCw data-icon="inline-start" />{syncing ? 'Syncing…' : 'Sync latest'}</Button>}
      />

      <SurfaceBox title="Your inbox" subheader="Unanswered comments first. Read and reply status is saved across visits." secondary={<MessageCircle className="size-5 text-brand" />}>
        <div className="grid gap-3 md:grid-cols-[minmax(12rem,0.7fr)_minmax(18rem,1.3fr)]">
          <label className="flex flex-col gap-1.5 text-small font-medium text-ink-muted">
            Instagram account
            <Select value={accountId} onValueChange={value => value && changeAccount(value)} items={accountOptions}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Choose an account" /></SelectTrigger>
              <SelectContent>{accountOptions.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
            </Select>
          </label>
        </div>
        <div role="group" aria-label="Filter comments" className="mt-4 flex flex-wrap gap-2">
          {([{ value: 'needs_reply', label: 'Needs reply' }, { value: 'unread', label: 'Unread' }, { value: 'replied', label: 'Replied' }, { value: 'all', label: 'All comments' }] as const).map(tab => <Button key={tab.value} variant={filter === tab.value ? 'default' : 'outline'} aria-pressed={filter === tab.value} onClick={() => changeFilter(tab.value)}>{tab.label}</Button>)}
        </div>
        <p className="mt-3 text-caption text-ink-faint">25 comments per page · {syncedAt ? `Last synced ${timeAgo(syncedAt)}` : 'Showing saved inbox'}{hasMoreSync ? ' · More history available to import.' : ''}</p>
        <p className="mt-1 text-caption text-ink-faint">Unread means not yet opened in Studio. Sync checks replies made on Instagram too.</p>
        {hasMoreSync && <Button className="mt-3" variant="outline" disabled={syncing} onClick={() => void syncBatch(accountId, 'history')}>{syncing ? 'Syncing…' : 'Import next batch of older comments'}</Button>}
        {syncError && <p role="alert" className="mt-2 text-small text-danger">{syncError}</p>}
      </SurfaceBox>

      {loadError && comments.length > 0 && <p role="alert" className="text-small text-danger">{loadError}</p>}
      {loadError && !comments.length ? <ErrorState title="Comments could not load" description={loadError} onRetry={() => setRevision(value => value + 1)} /> : (
        <div className="grid min-h-[34rem] gap-4 xl:h-[calc(100vh-23rem)] xl:grid-cols-[minmax(20rem,0.85fr)_minmax(25rem,1.15fr)]">
          <SurfaceBox title="Comments" subheader={loadingComments ? 'Loading inbox…' : `${comments.length} comments on this page`} className="min-h-[34rem] xl:min-h-0 xl:overflow-hidden" contentClassName="flex min-h-0 flex-1 flex-col gap-3">
            <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search this page" aria-label="Search comments" className="h-10 rounded-field border border-input bg-surface-raised px-3 text-sm text-ink placeholder:text-ink-faint" />
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
              {loadingComments && !comments.length && <p className="py-8 text-center text-small text-ink-muted">Loading comments…</p>}
              {!loadingComments && visibleComments.length === 0 && <EmptyState icon={<MessageCircle />} title={search ? 'No matching comments' : filter === 'needs_reply' ? 'No unanswered comments in the saved inbox' : 'No comments in this filter'} description={search ? 'Try another word or username.' : 'Sync Instagram to check for new comments, or import the next batch of older comments.'} />}
              {visibleComments.map(comment => {
                const active = selected?.id === comment.id;
                const replied = !!comment.repliedAt;
                return <button type="button" key={comment.id} onClick={() => void selectComment(comment)} className={`flex flex-col gap-2 rounded-control border p-3 text-left transition-colors ${active ? 'border-brand/50 bg-brand/5' : 'border-line hover:bg-surface-sunken'}`}>
                  <span className="flex items-center justify-between gap-2"><span className="truncate text-small font-semibold text-ink">@{comment.username}</span><span className="shrink-0 text-caption text-ink-faint" title={fmtDate(comment.timestamp)}>{comment.timestamp ? timeAgo(comment.timestamp) : ''}</span></span>
                  <span className="line-clamp-1 text-caption text-ink-faint">{comment.caption || 'Instagram post'}</span>
                  <span className="line-clamp-3 whitespace-pre-wrap text-small text-ink-muted">{comment.text || '[No text]'}</span>
                  <span className="flex items-center justify-between text-caption text-ink-faint"><span className="inline-flex items-center gap-1"><Heart className="size-3.5" />{comment.likeCount}</span>{replied ? <span className="font-medium text-success">Replied</span> : !comment.readAt ? <span className="font-medium text-brand">Unread</span> : <span>Needs reply</span>}</span>
                </button>;
              })}
            </div>
            <div className="flex items-center justify-between gap-2">
              <Button variant="outline" disabled={!history.length || loadingComments} onClick={() => { setCursor(history.at(-1)); setHistory(current => current.slice(0, -1)); }}>Previous</Button>
              <span className="text-caption text-ink-faint">Page {history.length + 1}</span>
              <Button variant="outline" disabled={!nextCursor || loadingComments} onClick={() => { setHistory(current => [...current, cursor]); setCursor(nextCursor ?? undefined); }}>Next</Button>
            </div>
          </SurfaceBox>

          <SurfaceBox title="Reply studio" subheader="Keep your reply human. The suggestion is only a draft until you post it." className="min-h-[34rem] xl:min-h-0 xl:overflow-hidden" contentClassName="flex min-h-0 flex-col gap-4 overflow-y-auto">
            {!selected ? <EmptyState icon={<MessageCircle />} title="Choose a comment" description="Select a comment to read it and draft a reply." /> : <>
              <div className="rounded-card border border-line bg-surface-sunken p-4">
                <div className="mb-2 flex items-start justify-between gap-3"><div><p className="text-small font-semibold text-ink">@{selected.username}</p><p className="text-caption text-ink-faint">{selected.timestamp ? fmtDate(selected.timestamp) : 'Instagram comment'}</p></div><span className="inline-flex items-center gap-1 text-caption text-ink-muted"><ThumbsUp className="size-3.5" />{selected.likeCount}</span></div>
                <p className="mb-3 line-clamp-2 border-b border-line pb-2 text-caption text-ink-faint">{selected.caption || 'Instagram post'}</p>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{selected.text || '[No text]'}</p>
              </div>
              {selected.repliedAt && <div className="rounded-control border border-line bg-surface-sunken p-3 text-small text-ink-muted"><span className="font-semibold text-success">Already replied</span><p className="mt-1 whitespace-pre-wrap">{selected.replyText || 'Reply detected on Instagram.'}</p></div>}
              {!selected.repliedAt && <>
              <div className="rounded-card border border-brand/20 bg-brand/5 p-4">
                <div className="flex items-start gap-3"><span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-brand/10 text-brand"><Sparkles className="size-4" /></span><div><h3 className="text-small font-semibold text-ink">Kindness Coach</h3><p className="mt-1 text-small text-ink-muted">A positive reply in the commenter’s language, grounded in what they said.</p></div></div>
                <Button className="mt-3" variant="outline" disabled={suggesting || !!selected.repliedAt} onClick={() => void draftKindReply()}><Sparkles data-icon="inline-start" />{suggesting ? 'Drafting a kind reply…' : 'Draft a hopeful reply'}</Button>
              </div>
              <label className="flex flex-col gap-1.5 text-small font-medium text-ink">Your reply
                <Textarea disabled={sending} value={reply} onChange={event => setReply(event.target.value)} maxLength={MAX_REPLY_CHARS} rows={5} placeholder="Write your reply or ask Kindness Coach for a draft…" />
              </label>
              <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-caption text-ink-faint">{reply.length}/{MAX_REPLY_CHARS} · Public replies are visible to everyone.</span><Button disabled={!reply.trim() || sending || !!selected.repliedAt} onClick={() => void sendReply()}><Send data-icon="inline-start" />{sending ? 'Posting…' : !!selected.repliedAt ? 'Reply posted' : 'Post reply'}</Button></div>
              </>}
              {actionError && <p role="alert" className="text-small text-danger">{actionError}</p>}
            </>}
          </SurfaceBox>
        </div>
      )}
      <p className="text-caption text-ink-faint">Instagram API access is limited to posts owned by the connected professional account. Replies are sent only when you press “Post reply.”</p>
    </div>
  );
}
