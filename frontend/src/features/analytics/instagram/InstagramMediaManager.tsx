import { useState } from 'react';
import { Button } from '@/components/ui/button';
import SurfaceBox from '@/components/SurfaceBox';
import ConfirmDialog from '@/components/ConfirmDialog';
import { api } from '../../../services/api';
import type { InstagramMedia } from '@shared/types/instagram.ts';

export default function InstagramMediaManager({ accountId, posts }: { accountId: string; posts: InstagramMedia[] }) {
  const [capabilities, setCapabilities] = useState<{ canDelete: boolean; canManageComments: boolean } | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleted, setDeleted] = useState<string[]>([]);
  const [removing, setRemoving] = useState<InstagramMedia | null>(null);
  async function check() {
    setBusy(true); setMessage('');
    try { setCapabilities(await api.getIGManagement(accountId)); }
    catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  async function comments(post: InstagramMedia, enabled: boolean) {
    setBusy(true); setMessage('');
    try { await api.setIGComments(accountId, post.id, enabled); setMessage(`Comments ${enabled ? 'enabled' : 'disabled'} for this post.`); }
    catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!removing || busy) return;
    setBusy(true); setMessage('');
    try { await api.deleteIGMedia(accountId, removing.id); setDeleted(current => [...current, removing.id]); setMessage('Post deleted from Instagram. Refresh analytics to update charts.'); }
    catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); setRemoving(null); }
  }
  return <SurfaceBox title="Manage published Instagram posts" subheader="Control comments and delete posts when your connected account has permission.">
    <div className="flex flex-col gap-3">
      <Button variant="outline" disabled={busy} onClick={check}>Check management access</Button>
      {message && <p role="status">{message}</p>}
      {capabilities && !capabilities.canDelete && <p className="text-sm">In-app deletion requires Facebook Login with instagram_manage_contents approved in your Meta app. Use Open in Instagram for this connection.</p>}
      <p className="text-sm">Caption changes, archiving and replacing a published video must be done in Instagram.</p>
      {posts.filter(post => !deleted.includes(post.id)).map(post => <div key={post.id} className="flex flex-col gap-2 rounded-control border p-3">
        <p className="line-clamp-2">{post.caption || 'No caption'}</p>
        <div className="flex flex-wrap gap-2">
          {post.permalink && <a className="text-sm underline" href={post.permalink} target="_blank" rel="noopener noreferrer">Open in Instagram to edit</a>}
          {capabilities?.canManageComments && <><Button variant="outline" disabled={busy} onClick={() => comments(post, true)}>Enable comments</Button><Button variant="outline" disabled={busy} onClick={() => comments(post, false)}>Disable comments</Button></>}
          {capabilities?.canDelete && <Button variant="destructive" disabled={busy} onClick={() => setRemoving(post)}>Delete</Button>}
        </div>
      </div>)}
      {!posts.length && <p>No recent posts loaded. Refresh this account to load media.</p>}
      <ConfirmDialog open={!!removing} onOpenChange={open => { if (!open && !busy) setRemoving(null); }} title="Delete this Instagram post?" description="This deletes the published post from Instagram. A carousel is deleted as a whole. This action cannot be undone here." cancelLabel="Keep post" confirmLabel={busy ? 'Deleting…' : 'Delete post'} onConfirm={() => { void remove(); }} />
    </div>
  </SurfaceBox>;
}
