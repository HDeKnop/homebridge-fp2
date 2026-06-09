import { describe, expect, it, vi } from 'vitest';

import { raceWithTimeout } from '../src/async-util.js';

describe('raceWithTimeout', () => {
  it('passes through a value when work resolves before the timeout', async () => {
    const result = await raceWithTimeout('getAccessories', Promise.resolve(42), 1000);
    expect(result).toBe(42);
  });

  it('passes through a rejection when work rejects before the timeout', async () => {
    await expect(raceWithTimeout('getAccessories', Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom');
  });

  it('rejects with a descriptive timeout error when work never settles', async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<number>(() => {
        /* never settles */
      });
      const raced = raceWithTimeout('getAccessories', never, 15_000);
      const assertion = expect(raced).rejects.toThrow('getAccessories timed out after 15000ms');
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not raise an unhandled rejection when an abandoned call rejects after the timeout', async () => {
    vi.useFakeTimers();
    try {
      let rejectWork: (err: Error) => void = () => undefined;
      const work = new Promise<number>((_resolve, reject) => {
        rejectWork = reject;
      });
      const raced = raceWithTimeout('getCharacteristics', work, 15_000);
      const assertion = expect(raced).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
      // The abandoned work settling late must be absorbed by the race reaction.
      rejectWork(new Error('late socket error'));
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
