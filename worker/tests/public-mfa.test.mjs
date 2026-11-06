import assert from 'node:assert/strict';
import test from 'node:test';
import { listMfaFactors } from '../../public/mfa.js';

test('MFA factor lookup reads the signed-in user endpoint', async () => {
  const factors = [{ factor_type: 'totp', status: 'verified' }];
  const calls = [];
  const result = await listMfaFactors(async (...args) => {
    calls.push(args);
    return { factors };
  }, 'access-token');

  assert.deepEqual(calls, [['/auth/v1/user', { t: 'access-token' }]]);
  assert.deepEqual(result, factors);
});

test('MFA factor lookup returns an empty list when the user has no factors', async () => {
  const result = await listMfaFactors(async () => ({}), 'access-token');
  assert.deepEqual(result, []);
});

test('MFA factor lookup requires a signed-in access token', async () => {
  await assert.rejects(() => listMfaFactors(async () => ({}), ''), /Sign in before managing/);
});
