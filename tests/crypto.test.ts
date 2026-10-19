import { describe, expect, it } from 'vitest';
import {
  encryptSecret,
  decryptSecret,
  hashPin,
  verifyPin,
  signOpaque,
  verifyOpaque,
  randomTag,
  randomId,
} from '../server/crypto';

describe('secret encryption', () => {
  it('round-trips with the same secret', async () => {
    const packed = await encryptSecret('unit-secret', 'sk-live-super-secret');
    expect(packed.startsWith('v1.')).toBe(true);
    expect(packed).not.toContain('sk-live-super-secret');
    await expect(decryptSecret('unit-secret', packed)).resolves.toBe('sk-live-super-secret');
  });

  it('fails with a different secret', async () => {
    const packed = await encryptSecret('unit-secret', 'value');
    await expect(decryptSecret('other-secret', packed)).rejects.toThrow();
  });

  it('produces different ciphertext for the same input (random IV)', async () => {
    const a = await encryptSecret('s', 'same');
    const b = await encryptSecret('s', 'same');
    expect(a).not.toBe(b);
  });
});

describe('PIN hashing', () => {
  it('verifies the correct PIN and rejects a wrong one', async () => {
    const stored = await hashPin('4821');
    expect(stored.startsWith('pbkdf2.120000.')).toBe(true);
    await expect(verifyPin('4821', stored)).resolves.toBe(true);
    await expect(verifyPin('4822', stored)).resolves.toBe(false);
  });

  it('rejects malformed stored values', async () => {
    await expect(verifyPin('1234', 'garbage')).resolves.toBe(false);
  });
});

describe('opaque tokens', () => {
  it('signs and verifies a payload', async () => {
    const token = await signOpaque('secret', 'pin:@mindflayer-abc', 60_000);
    await expect(verifyOpaque('secret', token)).resolves.toBe('pin:@mindflayer-abc');
  });

  it('rejects tampering, wrong secret and expiry', async () => {
    const token = await signOpaque('secret', 'sess:sub', 60_000);
    await expect(verifyOpaque('wrong', token)).resolves.toBe(null);
    await expect(verifyOpaque('secret', `${token}x`)).resolves.toBe(null);
    const expired = await signOpaque('secret', 'sess:sub', -1000);
    await expect(verifyOpaque('secret', expired)).resolves.toBe(null);
    await expect(verifyOpaque('secret', null)).resolves.toBe(null);
  });
});

describe('ids and tags', () => {
  it('mints unique-looking tags', () => {
    const tags = new Set(Array.from({ length: 200 }, () => randomTag()));
    expect(tags.size).toBeGreaterThan(190);
    for (const tag of tags) expect(tag).toMatch(/^@mindflayer-[a-z2-9]{6}$/);
  });

  it('mints distinct ids', () => {
    expect(randomId()).not.toBe(randomId());
  });
});
