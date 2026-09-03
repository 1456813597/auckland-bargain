/* oxlint-disable typescript/no-floating-promises -- node:test registration is intentionally not awaited. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isAuthorizedCronRequest } from '../lib/http/cron-auth';

describe('isAuthorizedCronRequest', () => {
  it('fails closed when the server has no cron secret', () => {
    const request = new Request('https://example.com/api/cron/test', {
      headers: { authorization: 'Bearer guessed' },
    });

    assert.equal(isAuthorizedCronRequest(request, undefined), false);
  });

  it('accepts only the configured bearer token', () => {
    const authorized = new Request('https://example.com/api/cron/test', {
      headers: { authorization: 'Bearer correct-secret' },
    });
    const unauthorized = new Request('https://example.com/api/cron/test', {
      headers: { authorization: 'Bearer wrong-secret' },
    });

    assert.equal(isAuthorizedCronRequest(authorized, 'correct-secret'), true);
    assert.equal(
      isAuthorizedCronRequest(unauthorized, 'correct-secret'),
      false,
    );
  });
});
