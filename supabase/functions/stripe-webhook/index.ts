// Stripe webhook: marks the voucher paid after checkout.session.completed.
// Secrets: STRIPE_WEBHOOK_SECRET (whsec_...). Deploy with JWT verification OFF.
const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

async function verify(body: string, header: string, secret: string) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = parts['t'];
  const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - Number(t)) > 600) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${body}`)));
  return sigs.some((s) => s.length === mac.length && [...s].every((c, i) => c === mac[i]));
}

Deno.serve(async (req) => {
  const body = await req.text();
  if (!(await verify(body, req.headers.get('stripe-signature') || '', Deno.env.get('STRIPE_WEBHOOK_SECRET') || ''))) {
    return new Response('bad signature', { status: 400 });
  }
  const ev = JSON.parse(body);
  if ((ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') && ev.data.object.payment_status === 'paid') {
    const s = ev.data.object;
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/rest/v1/rpc/kp_mark_paid`, {
      method: 'POST',
      headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ p_code: s.metadata?.code || s.client_reference_id, p_session: s.id, p_cents: s.amount_total }),
    });
    if (!r.ok) { console.error('mark_paid', await r.text()); return new Response('db error', { status: 500 }); }
  }
  return new Response('ok');
});
