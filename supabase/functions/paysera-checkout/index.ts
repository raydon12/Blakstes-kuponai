// Starts a Paysera payment for an online voucher order (status "unpaid").
//   GET  → {enabled}: the site asks this on load; without keys it keeps the manual "master marks paid" flow.
//   POST {code, lang} → {url}: signed Paysera link, the site redirects the buyer there.
// Secrets: PAYSERA_PROJECT_ID, PAYSERA_SIGN_PASSWORD, optional PAYSERA_TEST=1 (test payments), SITE_URL.
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided by Supabase. Deploy with JWT verification OFF.
import { payUrl } from '../_shared/paysera.ts';

const env = (k: string, d = '') => (Deno.env.get(k) || d).trim();
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'content-type': 'application/json' } });
const configured = () => /^\d+$/.test(env('PAYSERA_PROJECT_ID')) && !!env('PAYSERA_SIGN_PASSWORD');
const MIN_EUR = 40;

async function rpc(fn: string, args: Record<string, unknown>) {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const r = await fetch(`${env('SUPABASE_URL')}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${await r.text()}`);
  return r.json();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method === 'GET') return json({ enabled: configured(), test: configured() && env('PAYSERA_TEST') === '1' }, 200);
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  if (!configured()) return json({ error: 'not_configured' }, 503);
  try {
    const { code, lang } = await req.json().catch(() => ({}));
    const v = await rpc('kp_pay_info', { p_code: String(code || '') });
    if (!v) return json({ error: 'not_found' }, 404);
    if (v.source !== 'online' || v.status !== 'unpaid') return json({ error: 'not_payable' }, 409);
    if (!(v.amount >= MIN_EUR)) return json({ error: 'bad_amount' }, 409);
    const site = env('SITE_URL', 'https://blakstes-kuponai.vercel.app').replace(/\/$/, '');
    const c = encodeURIComponent(v.code);
    const url = payUrl({
      projectid: env('PAYSERA_PROJECT_ID'),
      orderid: v.code,
      amount: Math.round(v.amount * 100),
      currency: 'EUR',
      country: 'LT',
      lang: (lang || v.lang) === 'ru' ? 'RUS' : 'LIT',
      accepturl: `${site}/?paid=${c}`,
      cancelurl: `${site}/?cancelled=${c}`,
      callbackurl: `${env('SUPABASE_URL')}/functions/v1/paysera-callback`,
      p_email: v.email || undefined,
      paytext: 'Grin Lashes dovanų kuponas [order_nr] ([site_name])',
      test: env('PAYSERA_TEST') === '1' ? 1 : 0,
    }, env('PAYSERA_SIGN_PASSWORD'));
    return json({ url });
  } catch (e) {
    console.error(e);
    return json({ error: 'server' }, 500);
  }
});
