import { beforeEach, vi } from 'vitest';

// Every test must opt into an in-memory fetch adapter. Never use real HTTP.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Real HTTP disabled in offline tests'); }));
  vi.stubEnv('FULFILL_DRY_RUN', 'false');
});
