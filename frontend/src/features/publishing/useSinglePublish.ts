import { useRef, useState } from 'react';
import { api } from '../../services/api';
import { validateYouTubeShort } from './youtubeShortValidation.ts';
import { usePublishProgress } from './usePublishProgress';
import { publishSinglePost, scheduleSinglePost } from './singlePostFlow.ts';
import { singlePostError } from './publishHelpers.ts';
import type { MediaStorageConfig } from '../../services/api';
import type { AppContextValue } from '../../context/AppContext';
import type { PublishProgressState } from './usePublishProgress';
import type { SinglePostForm } from './useSinglePostForm';

export interface SinglePublishOptions {
  form: SinglePostForm;
  cloudConfig: MediaStorageConfig | null;
  showToast: AppContextValue['showToast'];
  onScheduled: () => void;
}

interface SinglePublishRun extends SinglePublishOptions {
  progress: PublishProgressState;
  setUploading: (uploading: boolean) => void;
  destinationResults: Map<string, { instagram?: string; youtube?: string }>;
}

function beginRun(run: SinglePublishRun): void {
  run.setUploading(true);
  run.progress.setPublishStatus('uploading-media');
  run.progress.setActiveStep(2);
}

function failRun(run: SinglePublishRun, err: Error, title: string): void {
  run.progress.setPublishStatus('error');
  run.progress.setStatusMessage(err.message);
  run.showToast(`${title}. ${err.message}`, 'error');
}

async function schedulePost(run: SinglePublishRun): Promise<void> {
  const { form, progress } = run;
  const scheduledAt = new Date(`${form.fields.scheduleDate}T${form.fields.scheduleTime}`);
  beginRun(run);
  try {
    await scheduleSinglePost(form, run.cloudConfig, scheduledAt, progress);
    progress.setPublishStatus('scheduled');
    progress.setStatusMessage(`Scheduled for ${scheduledAt.toLocaleString()}`);
    run.showToast('Post scheduled');
    run.onScheduled();
  } catch (err) {
    failRun(run, err as Error, 'Scheduling failed');
  } finally {
    run.setUploading(false);
  }
}

async function publishNow(run: SinglePublishRun): Promise<void> {
  const { progress } = run;
  beginRun(run);
  progress.setStatusMessage('Uploading media');
  try {
    const { form } = run;
    if (!form.file) throw new Error('Choose a video file before publishing.');
    if (form.youtubeAccount) {
      const shortError = await validateYouTubeShort(form.file);
      if (shortError) throw new Error(shortError);
    }
    const destinations = [Number(Boolean(form.publishInstagram && form.selectedAccount)), Number(Boolean(form.youtubeAccount))].filter(Boolean).length;
    let instagramProgress = 0;
    let youtubeProgress = 0;
    const updateCombinedProgress = () => progress.setUploadProgress(Math.round((instagramProgress + youtubeProgress) / destinations));
    const jobs: Array<Promise<{ platform: 'instagram' | 'youtube'; id: string }>> = [];
    const resultKey = `${form.file.name}:${form.file.size}:${form.file.lastModified}:${form.selectedAccount}:${form.youtubeAccount}`;
    const previous = run.destinationResults.get(resultKey) || {};
    const saveResult = (platform: 'instagram' | 'youtube', id: string) => {
      const current = run.destinationResults.get(resultKey) || {};
      run.destinationResults.set(resultKey, { ...current, [platform]: id });
    };
    if (form.publishInstagram && form.selectedAccount && !previous.instagram) {
      const instagramSetters = { ...progress, setUploadProgress: (value: number) => { instagramProgress = value; updateCombinedProgress(); } };
      jobs.push(publishSinglePost(form, run.cloudConfig, instagramSetters).then(id => {
        saveResult('instagram', id);
        return { platform: 'instagram' as const, id };
      }));
    }
    if (form.youtubeAccount && !previous.youtube) {
      jobs.push(api.uploadYouTubeShort(form.youtubeAccount, form.file, {
        title: form.youtubeTitle.trim() || form.file.name.replace(/\.[^.]+$/, '').slice(0, 100),
        description: form.youtubeDescription,
        privacyStatus: form.youtubePrivacy,
        onProgress: value => { youtubeProgress = value; updateCombinedProgress(); },
        resumeKey: `single-${form.youtubeAccount}-${form.file.name}-${form.file.size}-${form.file.lastModified}`,
      }).then(id => {
        saveResult('youtube', id);
        return { platform: 'youtube' as const, id };
      }));
    }
    const outcomes = await Promise.allSettled(jobs);
    const succeeded = [
      ...outcomes.flatMap(outcome => outcome.status === 'fulfilled' ? [outcome.value] : []),
      ...(previous.instagram ? [{ platform: 'instagram' as const, id: previous.instagram }] : []),
      ...(previous.youtube ? [{ platform: 'youtube' as const, id: previous.youtube }] : []),
    ];
    const failures = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [(outcome.reason as Error).message] : []);
    if (failures.length) {
      const published = succeeded.map(result => result.platform === 'youtube' ? `YouTube Short ${result.id}` : `Instagram Reel ${result.id}`).join(' and ');
      throw new Error(`${failures.join('; ')}${published ? `. Already published: ${published}.` : ''}`);
    }
    const instagram = succeeded.find(result => result.platform === 'instagram');
    const youtube = succeeded.find(result => result.platform === 'youtube');
    const mediaId = instagram?.id || '';
    progress.setPublishStatus('done');
    progress.setPublishedMediaId(mediaId);
    progress.setPublishedYouTubeId(youtube?.id || null);
    const message = instagram && youtube ? 'Published to Instagram Reels and YouTube Shorts' : youtube ? 'Published to YouTube Shorts' : 'Published to Instagram Reels';
    progress.setStatusMessage(message);
    run.showToast(message);
    run.destinationResults.delete(resultKey);
  } catch (err) {
    failRun(run, err as Error, 'Publishing failed');
  } finally {
    run.setUploading(false);
  }
}

export function useSinglePublish({ form, cloudConfig, showToast, onScheduled }: SinglePublishOptions) {
  const progress = usePublishProgress();
  const [uploading, setUploading] = useState(false);
  const destinationResults = useRef(new Map<string, { instagram?: string; youtube?: string }>());

  // reads the form as it is at the moment of the click
  const handlePublish = async () => {
    const error = singlePostError({ ...form, hasCloudConfig: Boolean(cloudConfig), now: new Date() });
    if (error) {
      showToast(error, 'error');
      return;
    }
    const run: SinglePublishRun = { form, cloudConfig, progress, setUploading, showToast, onScheduled, destinationResults: destinationResults.current };
    if (form.fields.scheduleMode) {
      await schedulePost(run);
      return;
    }
    await publishNow(run);
  };

  return { ...progress, uploading, handlePublish };
}

export type SinglePublish = ReturnType<typeof useSinglePublish>;
