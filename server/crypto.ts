/**
 * Crypto primitives: AES-GCM secret storage, PBKDF2 PIN hashing and
 * HMAC-signed stateless tokens (Google session cookie, PIN unlock token).
 * Uses only Web Crypto, which runs identically in workerd and Node.
 */

const te = new TextEncoder();
const td = new TextDecoder();

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Byte arrays backed by a real ArrayBuffer (TS 5.9 DOM generics). */
type Bytes = Uint8Array<ArrayBuffer>;

export function bytesToB64(bytes: Bytes): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64_ALPHABET[a >> 2];
    out += B64_ALPHABET[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64_ALPHABET[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? B64_ALPHABET[c & 63] : '=';
  }
  return out;
}

export function b64ToBytes(value: string): Bytes {
  const clean = value.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let outIdx = 0;
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const idx = B64_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    buffer = (buffer << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIdx++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, outIdx);
}

function b64url(bytes: Bytes): string {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(value: string): Bytes {
  return b64ToBytes(value.replace(/-/g, '+').replace(/_/g, '/'));
}

export function randomBytes(length: number): Bytes {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  return buf;
}

export function randomId(bytes = 16): string {
  return b64url(randomBytes(bytes));
}

const TAG_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** Unique human-facing handle, e.g. @mindflayer-7kq4m2 */
export function randomTag(): string {
  const raw = randomBytes(6);
  let out = '';
  for (const byte of raw) out += TAG_ALPHABET[byte % TAG_ALPHABET.length];
  return `@mindflayer-${out}`;
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', te.encode(`Mind Flayer:v1:${secret}`));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** `v1.<iv b64url>.<ciphertext b64url>` — used for connector API keys and Google client secrets. */
export async function encryptSecret(secret: string, plaintext: string): Promise<string> {
  const key = await aesKey(secret);
  const iv = randomBytes(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(plaintext)),
  );
  return `v1.${b64url(iv)}.${b64url(ct)}`;
}

export async function decryptSecret(secret: string, packed: string): Promise<string> {
  const [version, ivPart, ctPart] = packed.split('.');
  if (version !== 'v1' || !ivPart || !ctPart) throw new Error('Unsupported secret format');
  const key = await aesKey(secret);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64urlDecode(ivPart) },
    key,
    b64urlDecode(ctPart),
  );
  return td.decode(plain);
}

const PIN_ITERATIONS = 120_000;

/** `pbkdf2.<iterations>.<salt b64url>.<hash b64url>` */
export async function hashPin(pin: string, salt: Bytes = randomBytes(16)): Promise<string> {
  const material = await crypto.subtle.importKey('raw', te.encode(pin), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PIN_ITERATIONS, hash: 'SHA-256' },
    material,
    256,
  );
  return `pbkdf2.${PIN_ITERATIONS}.${b64url(salt)}.${b64url(new Uint8Array(bits))}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [version, iterPart, saltPart, hashPart] = stored.split('.');
  if (version !== 'pbkdf2' || !saltPart || !hashPart) return false;
  const iterations = Number(iterPart) || PIN_ITERATIONS;
  const material = await crypto.subtle.importKey('raw', te.encode(pin), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: b64urlDecode(saltPart), iterations, hash: 'SHA-256' },
    material,
    256,
  );
  const expected = b64urlDecode(hashPart);
  const actual = new Uint8Array(bits);
  if (expected.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= expected[i] ^ actual[i];
  return diff === 0;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

/**
 * Stateless signed token carrying its own payload:
 * `v1.<expMs>.<b64url payload>.<b64url HMAC>`. Payload is base64url encoded so
 * it can contain any characters (emails, dotted subs) without breaking parsing.
 */
export async function signOpaque(secret: string, payload: string, ttlMs: number): Promise<string> {
  const exp = Date.now() + ttlMs;
  const key = await hmacKey(secret);
  const encoded = b64url(te.encode(payload));
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, te.encode(`${payload}|${exp}`)),
  );
  return `v1.${exp}.${encoded}.${b64url(sig)}`;
}

/** Returns the payload when the signature is valid and unexpired, else null. */
export async function verifyOpaque(
  secret: string,
  token: string | null | undefined,
): Promise<string | null> {
  if (!token) return null;
  const [version, expPart, dataPart, sigPart] = token.split('.');
  if (version !== 'v1' || !expPart || !dataPart || !sigPart) return null;
  const exp = Number(expPart);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  let payload: string;
  try {
    payload = td.decode(b64urlDecode(dataPart));
  } catch {
    return null;
  }
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    b64urlDecode(sigPart),
    te.encode(`${payload}|${exp}`),
  );
  return ok ? payload : null;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  const parts = header
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.startsWith(`${name}=`));
  if (parts.length !== 1) return null;
  return parts[0].slice(name.length + 1) || null;
}

export function serializeCookie(
  name: string,
  value: string,
  opts: { maxAge?: number; secure?: boolean } = {},
): string {
  const maxAge = opts.maxAge ?? 0;
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAge > 0) parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  else parts.push('Max-Age=0');
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}
