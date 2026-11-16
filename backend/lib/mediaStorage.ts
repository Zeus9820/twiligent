export function ownedMediaObjectKey(publicUrlBase: string | undefined, mediaUrl: string | undefined, ownerPrefix?: string): string | null {
    if (!publicUrlBase || !mediaUrl) return null;
    let key: string;
    try {
        const base = new URL(publicUrlBase);
        const media = new URL(mediaUrl);
        const basePath = base.pathname.replace(/\/$/, '');
        const prefix = `${basePath}/`;
        if (media.origin !== base.origin || !media.pathname.startsWith(prefix)) return null;
        key = media.pathname.slice(prefix.length).split('/').map(decodeURIComponent).join('/');
    } catch {
        return null;
    }
    if (!key || key.split('/').some(part => !part || part === '.' || part === '..') || (ownerPrefix && !key.startsWith(ownerPrefix))) return null;
    return key;
}

export async function deletePublishedMedia(
    bucket: R2Bucket | undefined,
    publicUrlBase: string | undefined,
    mediaUrl: string | undefined,
    ownerPrefix?: string,
): Promise<boolean> {
    if (!bucket) return false;
    const key = ownedMediaObjectKey(publicUrlBase, mediaUrl, ownerPrefix);
    if (!key) return false;
    await bucket.delete(key);
    return true;
}
