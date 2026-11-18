// Paysera callback (callbackurl): Paysera calls it with ?data=…&ss1=…&ss2=… after a payment.
// Checks the ss1 signature, project, amount and currency, marks the voucher paid; the database trigger then emails the voucher.
// Must answer plain "OK", otherwise Paysera retries.
// Secrets: PAYSERA_PROJECT_ID, PAYSERA_SIGN_PASSWORD, optional PAYSERA_TEST=1 (accept test payments). Deploy with JWT verification OFF.
import { decode, verifySs1 } from '../_shared/paysera.ts';

const env = (k: string, d = '') => (Deno.env.get(k) || d).trim();
const text = (b: string, s = 200) => new Response(b, { status: s, headers: { 'content-type': 'text/plain' } });

async function params(req: Request) {
  const q = new URL(req.url).searchParams;
  if (req.method === 'POST') {
    const body = await req.text();
    for (const [k, v] of new URLSearchParams(body)) if (!q.has(k)) q.set(k, v);
  }
  return q;
}

Deno.serve(async (req) => {
  const pw = env('PAYSERA_SIGN_PASSWORD');
  if (!pw) return text('not configured', 503);
  const q = await params(req);
  const data = q.get('data') || '';
  if (!data || !verifySs1(data, q.get('ss1') || '', pw)) return text('bad signature', 400);

  const p = decode(data);
  if (p.projectid !== env('PAYSERA_PROJECT_ID')) return text('wrong project', 400);
  // type=macro is the payment notice; status 1 = paid. Status 0/2/3 (not paid / accepted, not executed yet / extra info) need no action.
  if ((p.type && p.type !== 'macro') || p.status !== '1') return text('OK');
  const test = p.test === '1';
  if (test && env('PAYSERA_TEST') !== '1') { console.warn('test payment ignored', p.orderid); return text('OK'); }
  if (p.currency !== 'EUR') { console.error('currency', p.orderid, p.currency); return text('wrong currency', 400); }

  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const r = await fetch(`${env('SUPABASE_URL')}/rest/v1/rpc/kp_mark_paid`, {
    method: 'POST',
    headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ p_code: p.orderid, p_provider: 'paysera', p_ref: p.requestid || p.orderid, p_cents: Number(p.amount), p_test: test }),
  });
  if (!r.ok) {
    const err = await r.text();
    console.error('mark_paid', p.orderid, err);
    // A wrong amount or unknown order will not fix itself on retry: answer so Paysera stops, the log keeps the details.
    if (/amount_mismatch|not_found/.test(err)) return text('rejected', 400);
    return text('db error', 500);
  }
  return text('OK');
});
