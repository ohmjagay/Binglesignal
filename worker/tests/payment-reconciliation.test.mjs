import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcilePayments } from '../../scripts/reconcile-payments.mjs';

const config = {
  RAZORPAY_KEY_ID: 'test-key',
  RAZORPAY_KEY_SECRET: 'test-secret',
  RAZORPAY_PLAN_PRO_MONTHLY: 'plan_pro_inr_month',
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
};

test('nightly reconciliation uses provider plan IDs and user-scoped database writes', async () => {
  const calls = [];
  const fetchMock = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.hostname === 'api.razorpay.com') {
      return Response.json({ items: [{
        id: 'sub_1', plan_id: 'plan_pro_inr_month', customer_id: 'cust_1',
        status: 'active', created_at: 1700000000, updated_at: 1700000001,
        current_end: 1702592000, notes: { user_id: 'user-1', plan: 'lite' },
      }] });
    }
    return new Response(null, { status: 204 });
  };
  const result = await reconcilePayments(config, fetchMock);
  assert.deepEqual(result, { scanned: 1, updated: 1 });
  const update = calls.find((call) => call.init.method === 'PATCH');
  assert.equal(update.url.searchParams.get('user_id'), 'eq.user-1');
  assert.match(update.url.searchParams.get('or'), /last_event_at\.lte/);
  const patch = JSON.parse(update.init.body);
  assert.equal(patch.plan, 'pro');
  assert.equal(patch.currency, 'INR');
  assert.equal(patch.billing_interval, 'month');
  assert.equal(patch.status, 'active');
});

test('nightly reconciliation refuses to update a subscription with an unknown plan ID', async () => {
  const calls = [];
  const fetchMock = async (input) => {
    const url = new URL(input);
    calls.push(url);
    return Response.json({ items: [{
      id: 'sub_unknown', plan_id: 'not-configured', status: 'active',
      notes: { user_id: 'user-1' },
    }] });
  };
  const result = await reconcilePayments(config, fetchMock);
  assert.deepEqual(result, { scanned: 1, updated: 0 });
  assert.equal(calls.some((url) => url.hostname === 'project.supabase.co'), false);
});
