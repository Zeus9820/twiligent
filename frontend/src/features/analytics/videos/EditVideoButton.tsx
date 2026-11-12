import AiMetadata from '@/components/AiMetadata';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { api } from '../../../services/api';
import type { ManagedVideo } from '../../../services/api';
import type { LibraryVideo } from './videoLibrary';

export default function EditVideoButton({ video }: { video: LibraryVideo }) {
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<ManagedVideo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  async function start() {
    setOpen(true); setBusy(true); setError(''); setEdit(null); setSaved(false);
    try { setEdit(await api.getManagedVideo(video.channelId, video.videoId)); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!edit || busy) return;
    setBusy(true); setError('');
    try { await api.editManagedVideo(video.channelId, edit); setSaved(true); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return <>
    <Button size="sm" variant="outline" onClick={start} aria-label={`Edit ${video.title}`}>Edit</Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Edit YouTube video</DialogTitle><DialogDescription>Change the published title and description here in Kratos Studio.</DialogDescription></DialogHeader>
        {busy && !edit && <p role="status">Loading video details…</p>}
        {error && <p role="alert" className="text-danger">{error}</p>}
        {error && !edit && <Button variant="outline" onClick={start} disabled={busy}>Try again</Button>}
        {saved ? <div><p role="status">Title and description saved to YouTube. Refresh the library to update its cached title.</p><Button onClick={() => setOpen(false)}>Done</Button></div> : edit && <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void save(); }}>
          <label htmlFor={`title-${video.videoId}`}>Title</label><Input id={`title-${video.videoId}`} required maxLength={100} value={edit.title} disabled={busy} onChange={event => setEdit({ ...edit, title: event.target.value })} />
          <label htmlFor={`description-${video.videoId}`}>Description</label><Textarea id={`description-${video.videoId}`} rows={7} maxLength={5000} value={edit.description} disabled={busy} onChange={event => setEdit({ ...edit, description: event.target.value })} />
          <AiMetadata context={`${edit.title}\n${edit.description}`} disabled={busy} onApply={value => setEdit({ ...edit, ...value })} />
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</Button>
        </form>}
      </DialogContent>
    </Dialog>
  </>;
}
