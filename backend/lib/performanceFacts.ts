import type { YouTubeVideo } from '../../shared/types/youtube.ts';
export function performanceFacts(videos: YouTubeVideo[], fetchedAt: string) {
    const rows = videos.map(video => ({ id: video.videoId, title: video.title.slice(0, 200), publishedAt: video.publishedAt, views: video.viewCount, likes: video.likeCount, comments: video.commentCount,
        interactionRatePercent: video.viewCount > 0 && video.likeCount !== null && video.commentCount !== null ? Math.round((video.likeCount + video.commentCount) / video.viewCount * 10000) / 100 : null }));
    const sorted = [...rows].sort((a, b) => b.views - a.views);
    const totalViews = rows.reduce((sum, row) => sum + row.views, 0);
    return { fetchedAt, scope: 'Lifetime counters for fetched videos; not a reporting-period comparison. Older videos have had longer to accumulate views. This dataset cannot establish Shorts classification, CTR, retention, watch time or causes.', videoCount: rows.length, totalViews, averageViews: rows.length ? Math.round(totalViews / rows.length) : 0,
        missingLikes: rows.filter(row => row.likes === null).length, missingComments: rows.filter(row => row.comments === null).length,
        topVideos: sorted.slice(0, 10), lowerViewVideos: sorted.slice(-5).reverse() };
}
