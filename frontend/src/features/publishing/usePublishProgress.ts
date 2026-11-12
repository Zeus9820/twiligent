import { useState } from 'react';
import type { PublishStatus } from './queueHelpers.ts';

export function usePublishProgress() {
  const [activeStep, setActiveStep] = useState(0);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [publishStatus, setPublishStatus] = useState<PublishStatus>('');
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [publishedMediaId, setPublishedMediaId] = useState<string | null>(null);
  const [publishedYouTubeId, setPublishedYouTubeId] = useState<string | null>(null);

  // try again goes back to the form but keeps the last upload percentage
  const retry = () => {
    setActiveStep(0);
    setPublishStatus('');
  };

  const resetProgress = () => {
    setActiveStep(0);
    setPublishStatus('');
    setStatusMessage('');
    setPublishedMediaId(null);
    setPublishedYouTubeId(null);
    setUploadProgress(0);
  };

  return {
    activeStep, setActiveStep, uploadProgress, setUploadProgress, publishStatus, setPublishStatus,
    statusMessage, setStatusMessage, publishedMediaId, setPublishedMediaId, publishedYouTubeId, setPublishedYouTubeId, retry, resetProgress,
  };
}

export type PublishProgressState = ReturnType<typeof usePublishProgress>;
