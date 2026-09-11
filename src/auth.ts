/**
 * PWA auth without a domain, a password, or an auth library: the Telegram bot
 * is the identity provider. `/app` mints a signed, expiring token and sends it
 * as a link fragment; the PWA stores it and presents it as a bearer token.
 */

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s: string): Uint8Array {
  const p = s.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(p + '='.repeat((4 - (p.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

/** Mint a token valid for `ttlDays` (default 30). */
export async function mintToken(secret: string, ttlDays = 30): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ exp: Date.now() + ttlDays * 86400_000 })));
  const sig = await crypto.subtle.sign('HMAC', await key(secret), enc.encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

export async function verifyToken(secret: string, token: string | null): Promise<boolean> {
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await key(secret), unb64url(sig), enc.encode(payload));
  } catch {
    return false;
  }
  if (!ok) return false;
  try {
    const { exp } = JSON.parse(new TextDecoder().decode(unb64url(payload)));
    return typeof exp === 'number' && exp > Date.now();
  } catch {
    return false;
  }
}

/** Constant-time-ish compare for the Telegram webhook secret header. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
