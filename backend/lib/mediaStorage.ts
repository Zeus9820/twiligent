export async function deletePublishedMedia(
    bucket: R2Bucket | undefined,
    publicUrlBase: string | undefined,
    mediaUrl: string | undefined,
    ownerPrefix?: string,
): Promise<boolean> {
    if (!bucket || !publicUrlBase || !mediaUrl) return false;
    let key: string;
    try {
        const base = new URL(publicUrlBase);
        const media = new URL(mediaUrl);
        const basePath = base.pathname.replace(/\/$/, '');
        const prefix = `${basePath}/`;
        if (media.origin !== base.origin || !media.pathname.startsWith(prefix)) return false;
        key = media.pathname.slice(prefix.length).split('/').map(decodeURIComponent).join('/');
    } catch {
        return false;
    }
    if (!key || key.split('/').some(part => !part || part === '.' || part === '..') || (ownerPrefix && !key.startsWith(ownerPrefix))) return false;
    await bucket.delete(key);
    return true;
}
