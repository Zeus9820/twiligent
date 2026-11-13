import { useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import AccountSelect from '@/components/AccountSelect';
import { api } from '../../services/api';
import type { AppAccount } from '../../utils/formatters';

interface PublishDestinationsProps {
  videoFile?: File | null;
  instagramAccounts: AppAccount[];
  youtubeAccounts: AppAccount[];
  instagramEnabled: boolean;
  onInstagramEnabled: (enabled: boolean) => void;
  instagramAccount: string;
  onInstagramAccount: (id: string) => void;
  youtubeAccount: string;
  onYoutubeAccount: (id: string) => void;
  title: string;
  onTitle: (value: string) => void;
  description: string;
  onDescription: (value: string) => void;
  privacy: 'private' | 'unlisted' | 'public';
  onPrivacy: (value: 'private' | 'unlisted' | 'public') => void;
  disabled?: boolean;
  showYouTubeMetadata?: boolean;
}

export default function PublishDestinations(props: PublishDestinationsProps) {
  const [connecting, setConnecting] = useState(false);
  const youtube = props.youtubeAccounts.find(account => account.id === props.youtubeAccount);
  const connectYouTube = async () => {
    if (!youtube) return;
    setConnecting(true);
    try { window.location.href = (await api.getYouTubeStudioUrl(youtube.id)).url; }
    catch (err) { window.alert((err as Error).message); setConnecting(false); }
  };
  return (
    <div className="flex flex-col gap-4 rounded-card border border-line p-4">
      <h3 className="font-semibold text-ink">Publish destinations</h3>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-ink">Instagram Reels</span>
        <Switch checked={props.instagramEnabled} onCheckedChange={props.onInstagramEnabled} disabled={props.disabled} aria-label="Publish to Instagram Reels" />
      </div>
      {props.instagramEnabled && <AccountSelect accounts={props.instagramAccounts} value={props.instagramAccount} onChange={props.onInstagramAccount} disabled={props.disabled} />}
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-ink">YouTube Shorts</span>
        <Switch checked={Boolean(props.youtubeAccount)} onCheckedChange={enabled => props.onYoutubeAccount(enabled ? (props.youtubeAccount || props.youtubeAccounts[0]?.id || '') : '')} disabled={props.disabled || props.youtubeAccounts.length === 0} aria-label="Publish to YouTube Shorts" />
      </div>
      {props.youtubeAccount && <div className="flex flex-col gap-3">
        <AccountSelect accounts={props.youtubeAccounts} value={props.youtubeAccount} onChange={props.onYoutubeAccount} disabled={props.disabled} />
        {youtube && !youtube.youtubePublishingConnected && <div className="rounded-field bg-warning-soft p-3 text-small text-ink-muted">
          <p className="mb-2">Reconnect this channel and approve YouTube upload access before publishing Shorts.</p>
          <button type="button" className="font-semibold text-brand-text underline" onClick={connectYouTube} disabled={connecting}>{connecting ? 'Connecting…' : 'Connect YouTube upload access'}</button>
        </div>}
        {props.showYouTubeMetadata !== false && <><label className="flex flex-col gap-1 text-small font-medium text-ink">Short title
          <input value={props.title} onChange={event => props.onTitle(event.target.value)} maxLength={100} disabled={props.disabled} className="h-10 rounded-control border border-line bg-surface px-3" placeholder="A clear title for your Short" />
        </label>
        <label className="flex flex-col gap-1 text-small font-medium text-ink">YouTube description
          <Textarea value={props.description} onChange={event => props.onDescription(event.target.value)} maxLength={5000} disabled={props.disabled} placeholder="Description for YouTube" rows={3} />
        </label>
        </>}
        <label className="flex flex-col gap-1 text-small font-medium text-ink">Visibility
          <select value={props.privacy} onChange={event => props.onPrivacy(event.target.value as PublishDestinationsProps['privacy'])} disabled={props.disabled} className="h-10 rounded-control border border-line bg-surface px-3">
            <option value="private">Private</option><option value="unlisted">Unlisted</option><option value="public">Public</option>
          </select>
        </label>
      </div>}
      {props.youtubeAccounts.length === 0 && <p className="text-sm text-ink-muted">Add a YouTube channel in Accounts to enable Shorts publishing.</p>}
      <p className="text-caption text-ink-faint">YouTube Shorts must be square or vertical, and 3 minutes or shorter.</p>
    </div>
  );
}
