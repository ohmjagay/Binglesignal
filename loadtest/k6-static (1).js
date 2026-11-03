// Run on your own computer:  k6 run loadtest/k6-static.js   (k6 is free: https://k6.io)
// Ramps to 2,000 simultaneous visitors against the public site. Do NOT point it at payment endpoints.
import http from 'k6/http'; import { check, sleep } from 'k6';
export const options = { stages: [{ duration: '1m', target: 500 }, { duration: '3m', target: 2000 }, { duration: '1m', target: 0 }], thresholds: { http_req_failed: ['rate<0.01'], http_req_duration: ['p(95)<800'] } };
const BASE = __ENV.BASE || 'https://binglesignal.com';
export default function () {
  for (const p of ['/', '/feed.json', '/api/health']) check(http.get(BASE + p), { [p + ' ok']: (r) => r.status === 200 });
  sleep(Math.random() * 3 + 1);
}
