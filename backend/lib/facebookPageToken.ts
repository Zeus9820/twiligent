import { ValidationError } from './errors.ts';

function keyBytes(value: string): Uint8Array {
    if (!/^[0-9a-f]{64}$/i.test(value)) throw new ValidationError('Facebook Page token encryption key is not configured correctly.');
    return Uint8Array.from(value.match(/.{2}/g) ?? [], hex => Number.parseInt(hex, 16));
}

async function cryptoKey(value: string, usage: Array<'encrypt' | 'decrypt'>): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', keyBytes(value), 'AES-GCM', false, usage);
}

function base64Url(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, char => char.charCodeAt(0));
}

export async function encryptFacebookPageToken(token: string, key: string, userId: string, accountId: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const additionalData = new TextEncoder().encode(`facebook-page:${userId}:${accountId}`);
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, await cryptoKey(key, ['encrypt']), new TextEncoder().encode(token));
    return `v1.${base64Url(iv)}.${base64Url(new Uint8Array(encrypted))}`;
}

export async function decryptFacebookPageToken(value: string, key: string, userId: string, accountId: string): Promise<string> {
    const [version, ivPart, dataPart, extra] = value.split('.');
    if (version !== 'v1' || !ivPart || !dataPart || extra) throw new ValidationError('Stored Facebook Page token is invalid. Reconnect the Page.');
    const additionalData = new TextEncoder().encode(`facebook-page:${userId}:${accountId}`);
    try {
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(ivPart), additionalData }, await cryptoKey(key, ['decrypt']), fromBase64Url(dataPart));
        return new TextDecoder().decode(decrypted);
    } catch {
        throw new ValidationError('Facebook Page token could not be decrypted. Reconnect the Page.');
    }
}
