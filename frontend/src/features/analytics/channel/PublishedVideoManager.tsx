import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import SurfaceBox from '@/components/SurfaceBox';
import ConfirmDialog from '@/components/ConfirmDialog';
import { api } from '../../../services/api';
import type { ManagedVideo } from '../../../services/api';

export default function PublishedVideoManager({ accountId }: { accountId: string }) {
  const [videos, setVideos] = useState<ManagedVideo[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [edit, setEdit] = useState<ManagedVideo | null>(null);
  const [removing, setRemoving] = useState<ManagedVideo | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function load(page = '') {
    setBusy(true); setMessage('');
    try { const result = await api.listManagedVideos(accountId, page); setVideos(current => page ? [...current, ...result.videos] : result.videos); setNext(result.nextPageToken); if (!result.videos.length) setMessage('No videos found.'); }
    catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, [accountId]);
  useEffect(() => {
    if (edit) document.getElementById('manage-title')?.focus();
  }, [edit?.id]);
  async function save() {
    if (!edit) return;
    setBusy(true); setMessage('');
    try { await api.editManagedVideo(accountId, edit); setVideos(current => current.map(video => video.id === edit.id ? edit : video)); setEdit(null); setMessage('Changes saved to YouTube.'); }
    catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!removing) return;
    setBusy(true);
    try { await api.deleteManagedVideo(accountId, removing.id); setVideos(current => current.filter(video => video.id !== removing.id)); setRemoving(null); setMessage('Video deleted from YouTube.'); }
    catch (error) { setMessage((error as Error).message); setRemoving(null); }
    finally { setBusy(false); }
  }
  return <SurfaceBox title="Manage published YouTube videos" subheader="Edit titles, descriptions and visibility, or delete videos. Reconnect YouTube above to approve video management access.">
    <div className="flex flex-col gap-4">
      <Button variant="outline" onClick={() => load()} disabled={busy}>Load / refresh videos</Button>
      {message && <p role="status">{message}</p>}
      {videos.map(video => <div key={video.id} className="flex flex-wrap items-center justify-between gap-3 rounded-control border p-3">
        <div><a href={`https://www.youtube.com/watch?v=${video.id}`} target="_blank" rel="noopener noreferrer" className="underline">{video.title}</a><p className="text-sm">{video.privacyStatus}</p></div>
        <div className="flex gap-2"><Button variant="outline" disabled={busy} onClick={() => { setEdit({ ...video }); setTimeout(() => document.getElementById('manage-title')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0); }}>Edit</Button><Button variant="destructive" disabled={busy} onClick={() => setRemoving(video)}>Delete</Button></div>
      </div>)}
      {next && <Button variant="outline" disabled={busy} onClick={() => load(next)}>Load more</Button>}
      {edit && <form className="flex flex-col gap-3 rounded-control border p-4" onSubmit={event => { event.preventDefault(); void save(); }}>
        <label htmlFor="manage-title">Title</label><Input id="manage-title" required maxLength={100} value={edit.title} disabled={busy} onChange={event => setEdit({ ...edit, title: event.target.value })} />
        <label htmlFor="manage-description">Description</label><Textarea id="manage-description" maxLength={5000} value={edit.description} disabled={busy} onChange={event => setEdit({ ...edit, description: event.target.value })} />
        <label htmlFor="manage-visibility">Visibility</label><select id="manage-visibility" value={edit.privacyStatus} disabled={busy} onChange={event => setEdit({ ...edit, privacyStatus: event.target.value })}><option value="public">Public</option><option value="unlisted">Unlisted</option><option value="private">Private</option></select>
        <div className="flex gap-2"><Button type="submit" disabled={busy}>Save changes</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setEdit(null)}>Cancel</Button></div>
      </form>}
      <ConfirmDialog open={!!removing} onOpenChange={open => { if (!open && !busy) setRemoving(null); }} title="Permanently delete this YouTube video?" description={`This removes “${removing?.title ?? ''}” from YouTube permanently. It cannot be undone.`} confirmLabel={busy ? 'Deleting…' : 'Delete permanently'} cancelLabel="Keep video" onConfirm={() => { if (!busy) void remove(); }} />
    </div>
  </SurfaceBox>;
}
