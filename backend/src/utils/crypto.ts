import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

const KEY = Buffer.from(env.ENCRYPTION_KEY, 'base64');

/** AES-256-GCM. Output: base64url(iv).base64url(tag).base64url(ciphertext) */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}

export function decryptSecret(payload: string): string {
  const [iv, tag, ct] = payload.split('.').map((p) => Buffer.from(p, 'base64url'));
  if (!iv || !tag || !ct) throw new Error('Malformed encrypted payload');
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
