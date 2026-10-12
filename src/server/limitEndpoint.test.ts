import { describe, it, expect } from '@jest/globals';
import { IncomingMessage, ServerResponse } from 'http';
import { handler } from './server';
import { charge, createUser, findByKey, setWeeklyLimit } from './accounts';
import { MSG } from '../i18n';

/** A fake (req, res) pair just enough for the handler's JSON-only routes. */
function call(reqUrl: string, init: { method?: string; headers?: Record<string, string>; body?: any } = {}) {
  const req: any = {
    url: reqUrl,
    method: init.method ?? 'GET',
    headers: init.headers ?? {},
    on: (ev: string, fn: (...a: any[]) => void) => {
      if (ev === 'data') fn(Buffer.from(JSON.stringify(init.body ?? {})));
      if (ev === 'end') fn();
      return req;
    },
    destroy: () => {},
  };
  let out = '';
  const res: any = {
    writeHead: (code: number) => { res._code = code; },
    end: (d?: any) => { out += String(d ?? ''); },
  };
  return { req, res, body: () => JSON.parse(out || '{}'), status: () => (res as any)._code as number };
}

describe('POST /v1/limit and the weekly guard on /v1/generate', () => {
  it('sets, reads and removes the personal cap through the endpoint', async () => {
    const { user, accessKey } = createUser(`limit-${Date.now()}@x.test`, 0);
    const auth = { authorization: `Bearer ${accessKey}`, 'content-type': 'application/json' };

    // set a cap
    let c = call('/v1/limit', { method: 'POST', headers: auth, body: { limit: 3 } });
    await handler(c.req, c.res);
    expect(c.status()).toBe(200);
    expect(c.body().weekly).toEqual({ limit: 3, left: 3 });

    // invalid value is a 400 with the friendly RO message
    c = call('/v1/limit', { method: 'POST', headers: auth, body: { limit: 0 } });
    await handler(c.req, c.res);
    expect(c.status()).toBe(400);
    expect(c.body().error).toBe(MSG.ro.invalidLimit);

    // remove the cap
    c = call('/v1/limit', { method: 'POST', headers: auth, body: { limit: null } });
    await handler(c.req, c.res);
    expect(c.status()).toBe(200);
    expect(c.body().weekly).toEqual({ limit: null, left: null });
    expect(findByKey(accessKey)!.weeklyLimit).toBeUndefined();
  });

  it('refuses a generation at the cap, charges nothing, RO and EN', async () => {
    const { user, accessKey } = createUser(`gen-${Date.now()}@x.test`, 5);
    const auth = { authorization: `Bearer ${accessKey}`, 'content-type': 'application/json' };
    setWeeklyLimit(user.email, 2);
    charge(user.id); charge(user.id); // burn the whole week
    const before = findByKey(accessKey)!;
    expect(before.weeklyLimit).toBe(2);
    expect(before.weekCount).toBe(2);
    expect(before.used).toBe(2);

    const c = call('/v1/generate', { method: 'POST', headers: auth, body: { tickets: 1, matches: 1 } });
    await handler(c.req, c.res);
    expect(c.status()).toBe(429);
    expect(c.body().error).toBe(MSG.ro.weeklyLimit(2));
    expect(typeof c.body().retryAfterHours).toBe('number');
    // nothing was charged: count and used unchanged
    const after = findByKey(accessKey)!;
    expect(after.used).toBe(2);
    expect(after.weekCount).toBe(2);
    // same refusal, English message
    const cEn = call('/v1/generate', { method: 'POST', headers: { ...auth, 'x-lang': 'en' }, body: { tickets: 1, matches: 1 } });
    await handler(cEn.req, cEn.res);
    expect(cEn.status()).toBe(429);
    expect(cEn.body().error).toBe(MSG.en.weeklyLimit(2));
  });
});
