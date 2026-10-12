import { describe, it, expect } from '@jest/globals';

// Importing server.ts does not touch the network or start the HTTP listen:
// the listen/refresh side effects run only when the file is executed directly.
import { health } from './server';

describe('GET /v1/health', () => {
  it('reports ok, the queued count and whether a job runs', () => {
    const h = health();
    expect(h.status).toBe('ok');
    expect(typeof h.queued).toBe('number');
    expect(h.queued).toBeGreaterThanOrEqual(0);
    expect(typeof h.running).toBe('boolean');
  });

  it('carries no user data', () => {
    expect(Object.keys(health()).sort()).toEqual(['queued', 'running', 'status']);
  });
});
