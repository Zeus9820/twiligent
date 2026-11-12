import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, FolderUp, Plus, Upload } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import PageHeader from '@/components/PageHeader';
import { useAppContext } from '../../context/AppContext';
import { useMediaStorageConfig } from '../../hooks/use-media-storage-config';
import BulkUploadTab from './BulkUploadTab';
import NoInstagramAccount from './NoInstagramAccount';
import ScheduledPostDialogs from './ScheduledPostDialogs';
import ScheduledPostsSection from './ScheduledPostsSection';
import SinglePostTab from './SinglePostTab';
import { useBulkPublish } from './useBulkPublish';
import { useBulkQueue } from './useBulkQueue';
import { useBulkSettings } from './useBulkSettings';
import { useScheduledPostDelete } from './useScheduledPostDelete';
import { useScheduledPostEdit } from './useScheduledPostEdit';
import { useScheduledPosts } from './useScheduledPosts';
import { useSinglePostForm } from './useSinglePostForm';
import { useSinglePublish } from './useSinglePublish';
import type { AppAccount } from '../../utils/formatters';

type UploadMode = 'single' | 'bulk' | 'youtube';

export default function UploadContent() {
  const { accounts, showToast } = useAppContext();
  const cloudConfig = useMediaStorageConfig(accounts);
  const [igAccounts, setIgAccounts] = useState<AppAccount[]>([]);
  const [youtubeAccounts, setYoutubeAccounts] = useState<AppAccount[]>([]);
  const [uploadMode, setUploadMode] = useState<UploadMode>(new URLSearchParams(window.location.search).get('platform') === 'youtube' ? 'youtube' : 'single');
  const schedule = useScheduledPosts();
  const { loadScheduledPosts } = schedule;
  const editor = useScheduledPostEdit({ showToast, loadScheduledPosts });
  const removal = useScheduledPostDelete({ showToast, loadScheduledPosts });
  const form = useSinglePostForm();
  const { setSelectedAccount } = form;
  const publish = useSinglePublish({ form, cloudConfig, showToast, onScheduled: loadScheduledPosts });
  const bulk = useBulkSettings();
  const queue = useBulkQueue({ sharedCaption: bulk.settings.sharedCaption, onFirstFiles: bulk.applyFirstBatchDefaults });
  const bulkPublish = useBulkPublish({ queue, settings: bulk.settings, cloudConfig, showToast, onScheduled: loadScheduledPosts });

  useEffect(() => {
    const instagramAccounts = (accounts || []).filter(account => account.platform === 'instagram' && !account.instagramProvider);
    const channels = (accounts || []).filter(account => account.platform === 'youtube');
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIgAccounts(instagramAccounts);
    setYoutubeAccounts(channels);
    if (instagramAccounts.length === 1) setSelectedAccount(instagramAccounts[0].id);
    if (instagramAccounts.length > 0 && !instagramAccounts.some(account => account.id === bulk.settings.account)) {
      bulk.setSetting('account', instagramAccounts[0].id);
    }
    loadScheduledPosts();
  }, [accounts, setSelectedAccount, loadScheduledPosts, bulk.settings.account, bulk.setSetting]);

  const chooseMode = (value: string) => {
    setUploadMode(value as UploadMode);
    if (value === 'youtube') {
      if (form.contentType !== 'REELS') form.changeContentType('REELS');
      form.setPublishInstagram(false);
      form.setYoutubeAccount(form.youtubeAccount || youtubeAccounts[0]?.id || '');
      form.setField('scheduleMode', false);
    }
  };
  useEffect(() => {
    if (uploadMode === 'youtube' && youtubeAccounts.length && !form.youtubeAccount) {
      form.setYoutubeAccount(youtubeAccounts[0].id);
    }
  }, [uploadMode, youtubeAccounts, form.youtubeAccount, form.setYoutubeAccount]);

  const resetAll = () => {
    form.resetForm();
    publish.resetProgress();
    if (uploadMode === 'youtube') {
      form.changeContentType('REELS');
      form.setPublishInstagram(false);
    }
  };

  if (igAccounts.length === 0 && youtubeAccounts.length === 0) return <NoInstagramAccount />;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Publish"
        description="Publish YouTube Shorts and Instagram Reels. Upload once to either platform or both."
        actions={publish.publishStatus === 'done' && uploadMode === 'single' && (
          <Button onClick={resetAll}><Plus data-icon="inline-start" />Publish another</Button>
        )}
      />

      {!cloudConfig && form.publishInstagram && (
        <Alert variant="warning">
          <AlertCircle />
          <AlertDescription>
            Publishing media storage is unavailable. Check the R2 bucket binding and public media domain, then try again.
          </AlertDescription>
        </Alert>
      )}

      <Tabs value={uploadMode} onValueChange={chooseMode} className="gap-6">
        <TabsList>
          <TabsTrigger value="youtube"><Upload />YouTube Short</TabsTrigger>
          <TabsTrigger value="single"><Upload />Instagram / both</TabsTrigger>
          <TabsTrigger value="bulk">
            <FolderUp />Bulk upload
            {queue.files.length > 0 && <Badge variant="solid" className="h-4 px-1.5">{queue.files.length}</Badge>}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="youtube">
          <SinglePostTab form={form} publish={publish} igAccounts={igAccounts} youtubeAccounts={youtubeAccounts} onReset={resetAll} />
        </TabsContent>
        <TabsContent value="single">
          <SinglePostTab form={form} publish={publish} igAccounts={igAccounts} youtubeAccounts={youtubeAccounts} onReset={resetAll} />
        </TabsContent>

        <TabsContent value="bulk">
          <BulkUploadTab bulk={bulk} queue={queue} bulkPublish={bulkPublish} igAccounts={igAccounts} youtubeAccounts={youtubeAccounts} />
        </TabsContent>
      </Tabs>

      {schedule.scheduledPosts.length > 0 && (
        <ScheduledPostsSection schedule={schedule} editor={editor} removal={removal} igAccounts={igAccounts} />
      )}

      <p className="text-caption text-ink-faint">
        Files upload to Cloudflare R2 in retryable multipart chunks because Instagram needs a public URL. Kratos Studio then creates an Instagram media container, waits for processing, and publishes it. Publishing needs the instagram_business_content_publish permission. Instagram allows 100 posts per account every 24 hours.
      </p>

      <ScheduledPostDialogs removal={removal} />
    </div>
  );
}
