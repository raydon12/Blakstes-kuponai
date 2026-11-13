// Creates a Stripe Checkout session for an online voucher order (status "unpaid").
// Secrets: STRIPE_SECRET_KEY, SITE_URL. SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'content-type': 'application/json' } });

async function rpc(fn: string, args: Record<string, unknown>) {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`${fn}: ${await r.text()}`);
  return r.json();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  try {
    const { code, lang } = await req.json();
    const v = await rpc('kp_pay_info', { p_code: String(code || '') });
    if (!v) return json({ error: 'not_found' }, 404);
    if (v.source !== 'online' || v.status !== 'unpaid') return json({ error: 'not_payable' }, 409);
    const site = (Deno.env.get('SITE_URL') || 'https://blakstes-kuponai.vercel.app').replace(/\/$/, '');
    const f = new URLSearchParams({
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'eur',
      'line_items[0][price_data][unit_amount]': String(Math.round(v.amount * 100)),
      'line_items[0][price_data][product_data][name]': `Dovanų kuponas ${v.amount} € — Grin Lashes`,
      client_reference_id: v.code,
      'metadata[code]': v.code,
      'payment_intent_data[metadata][code]': v.code,
      locale: lang === 'ru' ? 'ru' : 'lt',
      success_url: `${site}/?paid=${encodeURIComponent(v.code)}`,
      cancel_url: `${site}/?cancelled=${encodeURIComponent(v.code)}`,
      expires_at: String(Math.floor(Date.now() / 1000) + 3600),
    });
    if (v.email) f.set('customer_email', v.email);
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { authorization: `Bearer ${Deno.env.get('STRIPE_SECRET_KEY')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: f,
    });
    const s = await r.json();
    if (!r.ok) { console.error('stripe', s); return json({ error: 'stripe' }, 502); }
    return json({ url: s.url });
  } catch (e) {
    console.error(e);
    return json({ error: 'server' }, 500);
  }
});
