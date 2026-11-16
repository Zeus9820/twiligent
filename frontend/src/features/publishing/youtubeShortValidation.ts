export async function validateYouTubeShort(file: File): Promise<string | null> {
  if (!['video/mp4', 'video/quicktime'].includes(file.type)) return 'YouTube Shorts require an MP4 or MOV video.';
  const video = document.createElement('video');
  const url = URL.createObjectURL(file);
  try {
    return await new Promise(resolve => {
      video.preload = 'metadata';
      video.onloadedmetadata = () => {
        const { videoWidth: width, videoHeight: height, duration } = video;
        if (!width || !height || !Number.isFinite(duration) || duration <= 0) {
          resolve('Could not determine the video dimensions or duration. Try exporting the file again.');
        } else if (height < width) {
          resolve(`This video is ${width}×${height} (landscape). Export it as a square or vertical video for YouTube Shorts.`);
        } else if (duration > 180) {
          resolve(`This video is ${Math.ceil(duration)} seconds long. Trim it to 3 minutes or less for YouTube Shorts.`);
        } else resolve(null);
      };
      video.onerror = () => resolve('Could not read video dimensions and duration.');
      video.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
