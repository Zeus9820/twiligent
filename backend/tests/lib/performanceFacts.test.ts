import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performanceFacts } from '../../lib/performanceFacts.ts';
import type { YouTubeVideo } from '../../../shared/types/youtube.ts';
function video(id: string, views: number, likes: number | null, comments: number | null): YouTubeVideo {
    return { videoId: id, title: id, viewCount: views, likeCount: likes, commentCount: comments, publishedAt: '2026-11-01' } as YouTubeVideo;
}
test('ranks without mutating input and calculates counters', () => {
    const source = [video('low', 10, 1, 1), video('high', 100, 8, 2)];
    const facts = performanceFacts(source, '2026-11-13');
    assert.equal(facts.totalViews, 110); assert.equal(facts.averageViews, 55);
    assert.equal(facts.topVideos[0].id, 'high'); assert.equal(facts.topVideos[0].interactionRatePercent, 10);
    assert.equal(source[0].videoId, 'low');
});
test('missing counters and zero views do not become misleading rates', () => {
    const facts = performanceFacts([video('hidden', 50, null, 1), video('zero', 0, 0, 0)], 'now');
    assert.equal(facts.missingLikes, 1); assert.ok(facts.topVideos.every(row => row.interactionRatePercent === null));
    assert.equal(performanceFacts([], 'now').averageViews, 0);
});
