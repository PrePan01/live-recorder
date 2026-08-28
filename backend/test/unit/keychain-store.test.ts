import { describe, expect, it } from 'vitest';
import { KeytarSecretStore } from '../../src/security/keychain-store.js';

describe('KeytarSecretStore', () => {
  it('round-trips a secret through the OS keychain and cleans up', async () => {
    const store = new KeytarSecretStore();
    const key = `test.${Date.now()}`;
    try {
      expect(await store.has(key)).toBe(false);
      await store.set(key, 'value-1');
      expect(await store.has(key)).toBe(true);
      expect(await store.get(key)).toBe('value-1');
      await store.set(key, 'value-2');
      expect(await store.get(key)).toBe('value-2');
    } finally {
      await store.delete(key);
      expect(await store.has(key)).toBe(false);
    }
  });
});