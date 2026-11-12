export async function validateYouTubeShort(file: File): Promise<string | null> {
  if (!['video/mp4', 'video/quicktime'].includes(file.type)) return 'YouTube Shorts require an MP4 or MOV video.';
  const video = document.createElement('video');
  const url = URL.createObjectURL(file);
  try {
    return await new Promise(resolve => {
      video.preload = 'metadata';
      video.onloadedmetadata = () => {
        const isShortShape = video.videoHeight >= video.videoWidth;
        const isShortLength = video.duration > 0 && video.duration <= 180;
        resolve(isShortShape && isShortLength ? null : 'YouTube Shorts must be square or vertical and no longer than 3 minutes.');
      };
      video.onerror = () => resolve('Could not read video dimensions and duration.');
      video.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
