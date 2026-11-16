export interface InstagramComment {
    id: string;
    mediaId: string;
    text: string;
    username: string;
    timestamp: string;
    likeCount: number;
    hidden: boolean;
}

export interface InstagramCommentsPage {
    comments: InstagramComment[];
    nextCursor: string | null;
}

export interface InstagramCommentResponse {
    success: true;
    comment: InstagramComment;
}

export type InboxFilter = 'needs_reply' | 'unread' | 'replied' | 'all';
export interface InboxComment extends InstagramComment {
    caption: string;
    permalink: string;
    readAt?: string;
    repliedAt?: string;
    replyText?: string;
}
export interface InboxPage { comments: InboxComment[]; nextCursor: string | null }
export interface InboxSyncResult { imported: number; hasMore: boolean; syncedAt: string; busy?: boolean }
